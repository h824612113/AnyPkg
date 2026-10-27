'use strict';

/**
 * 任意包 / AnyPkg
 * 零依赖本地服务：聚合多个公开数据源，按「应用名」检索各平台安装包。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { execFile } = require('node:child_process');
const { smartText, smartJson, smartOpen, proxyStatus, runWithRequestContext } = require('./lib/net');
const gplay = require('./lib/gplay');
const apple = require('./lib/apple');
const appleAccounts = require('./lib/apple-accounts');
const snapcraft = require('./lib/snapcraft');
const fdroid = require('./lib/fdroid');
const izzy = require('./lib/izzy');
const apkpure = require('./lib/apkpure');
const winget = require('./lib/winget');
const flathub = require('./lib/flathub');
const chrome = require('./lib/chrome');
const devices = require('./lib/devices');
const appNames = require('./lib/names');
const { DownloadQueue, retryable } = require('./lib/queue');
const { createMcp } = require('./lib/mcp');

const PORT = Number(process.env.PORT || 8787);
const BIND_HOST = process.env.HOST || '127.0.0.1';
const REMOTE_TOKEN = process.env.ANYPKG_REMOTE_TOKEN || '';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const PUBLIC_DIR = path.join(__dirname, 'public');
const GH_TOKEN_ENV = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
let ghTokenCache;

/**
 * 没配环境变量时借本机 `gh` 的登录态：匿名 60 次/小时，登录后 5000 次/小时，
 * 而多数人不会专门为这个工具去建一个 PAT。取不到就静默退回匿名。
 */
function ghToken() {
  if (GH_TOKEN_ENV) return Promise.resolve(GH_TOKEN_ENV);
  if (ghTokenCache !== undefined) return Promise.resolve(ghTokenCache);
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000 }, (err, stdout) => {
      ghTokenCache = err ? '' : String(stdout || '').trim();
      resolve(ghTokenCache);
    });
  });
}
const UA = 'AnyPkg/0.2 (local meta-search)';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function fmtSize(bytes) {
  const n = Number(bytes);
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  // 应用宝的累计下载量是百亿级，只到「万」会打出 205191万 这种没人读得下去的数
  if (v >= 1e8) return `${(v / 1e8).toFixed(v >= 1e10 ? 0 : 1).replace(/\.0$/, '')}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .slice(0, 180) || 'download';
}

async function fetchJson(url, { headers = {}, timeout = 9000 } = {}) {
  // 统一走 lib/net：原生 fetch 不认代理，而 iTunes / Aptoide 在这类网络下直连不通。
  // 之前 iOS 与 Mac App Store 两栏整块报「fetch failed」就是这个原因。
  return smartJson(url, { headers: { 'user-agent': UA, ...headers }, timeout });
}

/* ------------------------------------------------------------------ */
/* 数据源 1：Apple（iOS App Store / Mac App Store）                     */
/* ------------------------------------------------------------------ */

/**
 * App Store 是分区的：同一个应用经常只在某几个区上架（工具类、银行、流媒体最常见），
 * 这也是 ipatool-py 的 `lookup -c JP` 和 ipaverse 的「切换 storefront」存在的原因。
 *
 * 检索这条链路不碰账号——itunes.apple.com/search 的 country 参数决定搜哪个区的目录，
 * 所以换区几乎零成本。真正的下载仍受账号所在区限制（ipatool 没有 --country），
 * 这一点在 UI 上会写清楚，别让人以为选了美区就能下美区的包。
 */
const APPLE_STORES = {
  cn: { label: '中国', lang: 'zh_cn' },
  us: { label: '美国', lang: 'en_us' },
  jp: { label: '日本', lang: 'ja_jp' },
  hk: { label: '中国香港', lang: 'zh_hk' },
  tw: { label: '中国台湾', lang: 'zh_tw' },
};

const DEFAULT_STORE = 'cn';
const STORE_CODES = Object.keys(APPLE_STORES);
// 「全部区」不是一个真实的 storefront，只是一个检索策略：五个区并行查完再合并
const ALL_STORES = 'all';

function storeInfo(code) {
  return APPLE_STORES[code] || APPLE_STORES[DEFAULT_STORE];
}

/**
 * 一张卡在哪些区上架。
 *
 * 这是「全部区」搜索结果里最有用的一条信息：工具类、银行、流媒体常常只上某几个区。
 * 只写「美国区」不够——用户需要知道「别的区都没有」，才会理解为什么下载可能失败。
 */
function storeTag(codes) {
  if (!codes || !codes.length) return '';
  if (codes.length >= STORE_CODES.length) return '全区上架';
  if (codes.length === 1) return `仅${APPLE_STORES[codes[0]].label}区`;
  const head = codes.slice(0, 3).map((c) => APPLE_STORES[c].label).join('·');
  return codes.length > 3 ? `${head} 等 ${codes.length} 区` : head;
}

async function itunes(term, entity, store = DEFAULT_STORE) {
  const key = APPLE_STORES[store] ? store : DEFAULT_STORE;
  const s = storeInfo(key);
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&country=${key}&entity=${entity}&limit=12&lang=${s.lang}`;
  const data = await fetchJson(url);
  return (data.results || []).map((r) =>
    mapApple(r, entity === 'macSoftware' ? 'macos' : 'ios', key)
  );
}

/**
 * 五个区并行搜同一个词，再按 bundleId 合并成一张卡。
 *
 * 为什么不能只是「多跑五遍然后拼起来」：同一个 App 在每个区都有一条记录，
 * 直接拼会让「微信」出现五次。合并之后还要挑一条当代表——
 * 挑法按名字和搜索词的匹配度，而不是按区固定优先：
 * 搜「微信」时中国区那条叫「微信」，日本区叫 WeChat，前者才是用户想要的；
 * 但搜「WeChat」时反过来。兜底再偏向默认区（中文简介更好懂）。
 */
async function itunesAll(term, entity) {
  const settled = await Promise.allSettled(STORE_CODES.map((code) => itunes(term, entity, code)));
  const ok = settled.filter((r) => r.status === 'fulfilled');
  // 一个区挂了不该让整栏变红，只有全挂才算这条源失败
  if (!ok.length) {
    const first = settled.find((r) => r.status === 'rejected');
    throw first ? first.reason : new Error('App Store 全部区都失败');
  }

  const byApp = new Map();
  for (const r of ok) {
    for (const item of r.value) {
      const key = item.bundleId || item.id;
      const prev = byApp.get(key);
      if (!prev) {
        byApp.set(key, { item, codes: [item.storeCode] });
        continue;
      }
      prev.codes.push(item.storeCode);
      const cand = relevance(item.name, term);
      const best = relevance(prev.item.name, term);
      if (cand > best || (cand === best && item.storeCode === DEFAULT_STORE)) {
        prev.item = item;
      }
    }
  }

  const regionMeta = new Set(STORE_CODES.map((c) => `${APPLE_STORES[c].label}区`));
  const out = [];
  for (const { item, codes } of byApp.values()) {
    // 按搜索顺序排一下，卡片上「中国·美国」比「美国·中国」自然
    codes.sort((a, b) => STORE_CODES.indexOf(a) - STORE_CODES.indexOf(b));
    item.meta = item.meta.filter((m) => !regionMeta.has(m));
    item.meta.push(storeTag(codes));
    // 合并后的 id 不绑区，前端、缓存里同一张卡只有一个身份
    item.id = `apple:${item.platforms[0]}:${ALL_STORES}:${item.bundleId || item.id}`;
    item.stores = codes;
    item.source = codes.length >= STORE_CODES.length
      ? 'App Store 全区'
      : `App Store ${codes.map((c) => APPLE_STORES[c].label).join('/')}`;
    out.push(item);
  }
  return out;
}

/** 检索入口：选了「全部区」就并行查五个区，否则单区直查 */
function appleSearch(term, entity, store) {
  return store === ALL_STORES ? itunesAll(term, entity) : itunes(term, entity, store || DEFAULT_STORE);
}

function mapApple(r, platform, store = DEFAULT_STORE) {
  const size = Number(r.fileSizeBytes) || 0;
  const osName = platform === 'macos' ? 'macOS' : 'iOS';
  const region = storeInfo(store);
  return {
    id: `apple:${platform}:${store}:${r.trackId}`,
    // 合并多区结果时要知道这一条来自哪个区，别靠 id 反解
    storeCode: store,
    // 注意：这里不给 stores。单区检索只知道「这个区有」，说不出「只有这个区有」，
    // 而 stores 在 UI 上会被读成「仅X区上架」。那个字段只由 itunesAll() 合并后写入。
    name: r.trackName || '',
    publisher: r.sellerName || r.artistName || '',
    bundleId: r.bundleId || '',
    icon: r.artworkUrl512 || r.artworkUrl100 || '',
    summary: (r.description || '').replace(/\s+/g, ' ').slice(0, 150),
    tags: (r.genres || []).slice(0, 2),
    platforms: [platform],
    meta: [
      r.version ? `v${r.version}` : '',
      fmtSize(size),
      r.minimumOsVersion ? `需 ${osName} ${r.minimumOsVersion}+` : '',
      // 默认区不标，免得每张卡片都挂个「中国」；换了区才需要提醒这包是哪儿的
      store === DEFAULT_STORE ? '' : `${region.label}区`,
    ].filter(Boolean),
    rating:
      r.averageUserRating > 0
        ? { score: Number(r.averageUserRating.toFixed(1)), count: r.userRatingCount || 0 }
        : null,
    pop: r.userRatingCount || 0,
    // iTunes 只给评分人数，没有下载量。评级人数当热度用（评分率约 1%），
    // 在 heatOf 里按 rating 的刻度折算，不能和应用宝的下载量直接比大小
    popUnit: 'rating',
    price: r.formattedPrice || (r.price === 0 ? '免费' : ''),
    updated: r.currentVersionReleaseDate || r.releaseDate || '',
    source: store === DEFAULT_STORE ? 'App Store 中国' : `App Store ${region.label}`,
    sourceUrl: r.trackViewUrl,
    downloads: [
      {
        label: platform === 'ios' ? '前往 App Store' : '前往 Mac App Store',
        url: r.trackViewUrl,
        kind: 'store',
        platform,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 数据源 2：Homebrew Cask（macOS，厂商官方直链，可直接下载 .dmg/.pkg）  */
/* ------------------------------------------------------------------ */

const CASK_CACHE = path.join(__dirname, '.cache', 'casks.json');
const CASK_TTL = 24 * 60 * 60 * 1000;
// 内存索引 + 加载中的 promise：两个变量而不是一个 promise，
// 因为「后台刷新」需要在不挡住当前请求的前提下更新内存索引
let caskIndex = null;
let caskLoading = null;

function compactCask(c, pop) {
  return {
    token: c.token,
    names: (c.name || []).map(String),
    desc: c.desc || '',
    url: c.url || '',
    version: String(c.version || ''),
    homepage: c.homepage || '',
    pop: pop || 0,
  };
}

/** 7k+ 个 cask 的索引，本地缓存 24 小时；19MB 的原始 JSON 太大，缓存压缩后的版本 */
async function loadCasks() {
  if (caskIndex) return caskIndex;
  if (caskLoading) return caskLoading;

  caskLoading = (async () => {
    let cached = null;
    let age = Infinity;
    try {
      const st = await fsp.stat(CASK_CACHE);
      age = Date.now() - st.mtimeMs;
      cached = JSON.parse(await fsp.readFile(CASK_CACHE, 'utf8'));
    } catch {
      /* 没有缓存，只能去下载 */
    }

    if (cached) {
      caskIndex = cached;
      // 过期了就后台刷新，这次搜索先用旧索引。
      // 19MB 的 cask.json 拉一次要几十秒（本机实测经常 >20s 直接超时），
      // 绝不能让它挡在搜索路径上——索引晚一天更新没有任何影响
      if (age > CASK_TTL) refreshCasks().catch(() => {});
      return cached;
    }
    return refreshCasks();
  })()
    .catch((e) => {
      throw e;
    })
    .finally(() => {
      caskLoading = null;
    });

  return caskLoading;
}

/** 真正去 formulae.brew.sh 拉索引。只在「没有缓存」或「缓存过期」时被调用 */
async function refreshCasks() {
  // 90 天装机量，用来在相关度相同时判断「哪个才是大家真正在用的那个」
  const [raw, ana] = await Promise.all([
    fetchJson('https://formulae.brew.sh/api/cask.json', { timeout: 45000 }),
    fetchJson('https://formulae.brew.sh/api/analytics/cask-install/90d.json', {
      timeout: 30000,
    }).catch(() => null),
  ]);

  const pop = new Map();
  for (const it of ana?.items || []) {
    pop.set(it.cask, Number(String(it.count).replace(/,/g, '')) || 0);
  }

  const compact = raw
    .filter((c) => !c.disabled && c.url)
    .map((c) => compactCask(c, pop.get(c.token)));

  caskIndex = compact;
  try {
    await fsp.mkdir(path.dirname(CASK_CACHE), { recursive: true });
    await fsp.writeFile(CASK_CACHE, JSON.stringify(compact));
  } catch {
    /* 缓存写失败不影响本次使用 */
  }
  return compact;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function caskFilename(c) {
  const clean = String(c.url).split('?')[0];
  const base = decodeURIComponent(clean.substring(clean.lastIndexOf('/') + 1));
  if (/\.(dmg|pkg|zip|tar\.gz|tgz|tbz2|7z)$/i.test(base)) return base;
  const ver = c.version.split(',')[0];
  return `${c.token}${ver ? '-' + ver : ''}.zip`;
}

async function homebrewSource(term) {
  const casks = await loadCasks();
  const q = term.toLowerCase().trim();

  const scored = [];
  for (const c of casks) {
    let best = 0;
    let bestAlias = '';
    for (const n of [c.token, ...c.names]) {
      const r = relevance(n, q);
      if (r > best) {
        best = r;
        bestAlias = n;
      }
    }
    if (best > 0) scored.push({ c, rel: best, alias: bestAlias });
  }

  scored.sort((a, b) => {
    if (b.rel !== a.rel) return b.rel - a.rel;
    // 同分看装机量：微信 Mac 版该排在微信输入法前面
    if ((b.c.pop || 0) !== (a.c.pop || 0)) return (b.c.pop || 0) - (a.c.pop || 0);
    return a.alias.length - b.alias.length;
  });

  return scored.slice(0, 8).map(({ c, rel, alias }) => {
    // 命中的是中文别名就显示中文名，别让用户对着 "WeChat for Mac" 猜
    const name = alias && alias !== c.token ? alias : c.names[0] || c.token;
    const ext = (caskFilename(c).match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    const filename = caskFilename(c);
    const ver = c.version.split(',')[0];
    const host = hostOf(c.homepage);

    return {
      id: `brew:${c.token}`,
      name,
      rel,
      publisher: host,
      icon: host ? `https://www.google.com/s2/favicons?domain=${host}&sz=128` : '',
      summary: c.desc,
      tags: [c.token],
      platforms: ['macos'],
      meta: [ver ? `v${ver}` : '', ext ? ext.toUpperCase() : '直装包', '官方直链'].filter(Boolean),
      rating: null,
      price: '免费',
      pop: c.pop || 0,
      updated: '',
      source: 'Homebrew Cask',
      sourceUrl: `https://formulae.brew.sh/cask/${c.token}`,
      downloads: [
        {
          label: filename,
          short: `macOS · ${ext ? ext.toUpperCase() : '直装包'}`,
          url: c.url,
          kind: 'direct',
          platform: 'macos',
          filename,
        },
      ],
    };
  });
}

/* ------------------------------------------------------------------ */
/* 数据源 3：Aptoide（Android，可直接下载 .apk）                        */
/* ------------------------------------------------------------------ */

async function aptoideSource(term) {
  const data = await smartJson(
    `https://ws75.aptoide.com/api/7/apps/search?query=${encodeURIComponent(term)}&limit=12`,
    { timeout: 16000 }
  );
  const list = data?.datalist?.list || [];

  return list
    .map((a) => {
      const f = a.file || {};
      const pkg = a.package || '';
      const ver = f.vername || '';
      // 证书里的 CN 是唯一不能自封的开发者身份，比商店里填的 developer 名字可信
      const certCn = (f.signature?.owner || '').match(/CN=([^,]+)/)?.[1] || '';
      const rating = a.stats?.prating;
      return {
        id: `aptoide:${pkg}`,
        name: a.name || pkg,
        publisher: a.developer?.name || certCn,
        packageId: pkg,
        version: ver,
        icon: a.icon ? `${a.icon}${a.icon.includes('?') ? '&' : '?'}w=160` : '',
        summary: '',
        tags: [pkg],
        platforms: ['android'],
        meta: [ver ? `v${ver}` : '', fmtSize(f.filesize || a.size)].filter(Boolean),
        rating:
          rating?.avg > 0
            ? { score: Number(rating.avg.toFixed(1)), count: rating.total || 0 }
            : null,
        price: '免费',
        pop: a.stats?.pdownloads || 0,
        // Aptoide 的 pdownloads 是分档值（5M / 1B 这种），不是精确数，
        // 但量级是对的，拿来排序足够
        popUnit: 'install',
        updated: a.modified || '',
        source: 'Aptoide',
        sourceUrl: `https://en.aptoide.com/app/${pkg}`,
        trust: f.malware?.rank === 'TRUSTED' ? `签名 ${certCn.slice(0, 20) || '已验证'}` : '',
        downloads: f.path
          ? [
              {
                label: `${pkg}-${ver || 'app'}.apk`,
                short: `Aptoide · v${ver || '?'}`,
                url: f.path,
                kind: 'direct',
                platform: 'android',
                size: fmtSize(f.filesize || a.size),
                filename: `${pkg}-${ver || 'app'}.apk`,
              },
            ]
          : [],
      };
    })
    .filter((a) => a.downloads.length);
}

/* ------------------------------------------------------------------ */
/* 数据源 3b：Aptoide 历史版本（降级用）                                */
/* ------------------------------------------------------------------ */

/**
 * listAppVersions 只给「版本号 / 日期 / 体积 / MD5」，**不带下载地址**；
 * 地址要按 vercode 再查一次 getApp。所以列表先吐元数据，用户点哪条再解析哪条，
 * 避免一次搜索顺手打十几个下载接口。
 */
async function aptoideVersions(pkg, onEvent) {
  const data = await smartJson(
    `https://ws75.aptoide.com/api/7/listAppVersions?package_name=${encodeURIComponent(pkg)}&limit=40`,
    { timeout: 16000 }
  );

  const seen = new Set();
  const rows = [];
  for (const v of data?.list || []) {
    const f = v.file || {};
    const code = Number(f.vercode) || 0;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    rows.push({
      type: 'version',
      vercode: code,
      version: f.vername || '',
      date: String(f.added || v.added || '').slice(0, 10),
      size: fmtSize(f.filesize || v.size),
      md5: f.md5sum || '',
      trusted: f.malware?.rank === 'TRUSTED',
    });
  }

  // Aptoide 的返回顺序不稳定（老版本会插在中间），而且偶尔有上传者把 versionCode
  // 填成 2147483647（int 上限），按 code 排会把它顶到最前面。所以先按版本号自然序，
  // 版本号相同再看 code。再往前翻的版本多半连签名都对不上现在的系统，截 30 条。
  rows.sort((a, b) => cmpVersion(b.version, a.version) || b.vercode - a.vercode);
  for (const row of rows.slice(0, 30)) onEvent(row);
  onEvent({ type: 'done', count: Math.min(rows.length, 30) });
}

/** 单个版本的直链，只在这一步才解析 */
async function aptoideVersionUrl(pkg, vercode) {
  const data = await smartJson(
    `https://ws75.aptoide.com/api/7/getApp?package_name=${encodeURIComponent(pkg)}&vercode=${encodeURIComponent(vercode)}`,
    { timeout: 16000 }
  );
  const f = data?.nodes?.meta?.data?.file || {};
  return { url: f.path || '', version: f.vername || '', md5: f.md5sum || '' };
}

/* ------------------------------------------------------------------ */
/* 数据源 3b：应用宝（腾讯，国内 App 直下，无需登录）                   */
/* ------------------------------------------------------------------ */

const YYB_SKIP = new Set(['com.tencent.android.qqdownloader']); // 应用宝自己的安装包

/**
 * 页面里内嵌的是 `window.systemData={...}` 和 Next.js 的 `__NEXT_DATA__`，
 * 都是裸 JSON。写个括号配平器切出来，比正则可靠——字段顺序变了也不会挂。
 */
function objectAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('{', at + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 搜索结果只给包名和版本，APK 地址要再打一次详情页 */
async function yybSearch(term) {
  const html = await smartText(`https://sj.qq.com/search?q=${encodeURIComponent(term)}`, {
    timeout: 16000,
    headers: { accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' },
  });

  const data = objectAfter(html, '__NEXT_DATA__');
  const components = data?.props?.pageProps?.dynamicCardResponse?.data?.components || [];

  const out = [];
  const seen = new Set();
  for (const comp of components) {
    for (const it of comp?.data?.itemData || []) {
      const pkg = it.pkg_name || it.relevance_pkg_name;
      if (!pkg || !it.name || YYB_SKIP.has(pkg) || seen.has(pkg)) continue;
      seen.add(pkg);
      out.push({
        pkg,
        name: it.name,
        icon: it.icon || '',
        publisher: it.developer || '',
        version: it.version_name || '',
        size: Number(it.apk_size) || 0,
        intro: (it.editor_intro || '').replace(/\s+/g, ' ').slice(0, 150),
        pop: Number(it.syzs_download_num) || 0,
        updated: it.update_time ? new Date(Number(it.update_time) * 1000).toISOString() : '',
      });
    }
  }
  return out;
}

/**
 * 详情页缓存。
 *
 * a.app.qq.com 的详情页单次要 3~4 秒，是整条搜索链上最贵的一次往返：
 * 6 个并发在全源同时加载时能拖到 15 秒以上，`runSource` 的 20 秒预算就是被它吃满的。
 * 但同一个包名的 APK 地址、版本、下载量一小时内基本不会变，缓存下来之后
 * 重复搜索、翻历史版本、点开详情全都能直接命中。
 *
 * 失败单独用一个短 TTL：一次超时不能当成「这个包没有落地页」记一小时。
 */
const YYB_DETAIL_TTL = 60 * 60 * 1000;
const YYB_DETAIL_FAIL_TTL = 5 * 60 * 1000;
const YYB_DETAIL_MAX = 800;
const yybDetailCache = new Map();

function rememberYybDetail(pkg, value) {
  // 简单 FIFO 淘汰：Map 迭代按插入顺序，超上限就丢最早的那条。
  // 800 条足够覆盖一天的搜索热词，内存也就几百 KB
  if (yybDetailCache.size >= YYB_DETAIL_MAX) {
    const oldest = yybDetailCache.keys().next().value;
    if (oldest) yybDetailCache.delete(oldest);
  }
  yybDetailCache.set(pkg, { at: Date.now(), value });
}

async function yybDetail(pkg) {
  const hit = yybDetailCache.get(pkg);
  if (hit) {
    const ttl = hit.value ? YYB_DETAIL_TTL : YYB_DETAIL_FAIL_TTL;
    if (Date.now() - hit.at < ttl) return hit.value;
  }

  let html;
  try {
    html = await smartText(`https://a.app.qq.com/o/simple.jsp?pkgname=${encodeURIComponent(pkg)}`, {
      timeout: 12000,
      headers: { accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' },
    });
  } catch (e) {
    // 超时也记一笔短冷却：不记的话同一轮里 3 个请求会各等 12 秒，
    // 下一次搜索还会原样重来一遍（实测第二次仍在 9 秒以上）
    rememberYybDetail(pkg, null);
    throw e;
  }

  const detail = objectAfter(html, 'window.systemData')?.appDetail;
  // packageName 对不上说明这个包在应用宝没有落地页（会回落成应用宝自己）
  if (!detail || detail.packageName !== pkg || !detail.apkUrl) {
    rememberYybDetail(pkg, null);
    return null;
  }

  const value = {
    apkUrl: detail.apkUrl,
    version: detail.versionName || '',
    size: Number(detail.fileSize?.bytes) || 0,
    md5: detail.apkMd5 || '',
    name: detail.appName || '',
    publisher: detail.developer || detail.author || '',
    icon: detail.iconUrl || '',
    intro: (detail.editorIntro || '').replace(/\s+/g, ' ').slice(0, 150),
    rating: Number(detail.rating?.averageRating) || 0,
    ratingCount: Number(detail.rating?.ratingCount) || 0,
    // 2026-10 页面改版：老的 download_num 字段没了，下载量挪到 downCount.bytes，
    // 形如 {"bytes":"8979241587","desc":"89 亿次"}。这是全渠道累计下载，
    // 是判断「谁是这个应用的正主」最硬的证据（微信 89 亿，Figma Mirror 只有几百万）
    downloads: Number(detail.downCount?.bytes) || Number(detail.download_num) || 0,
  };

  rememberYybDetail(pkg, value);
  return value;
}

async function yybSource(term) {
  const found = await yybSearch(term);
  if (!found.length) return [];

  // 详情页是这条链上最贵的一步：单次 3~4 秒，而且应用宝对并发不友好
  // （6 个并发实测要 17 秒，占满 runSource 的 20 秒预算）。
  // 只给最相关的 3 个补直链——搜索页的第一名就是用户要的那个，
  // 剩下的条目退化成「去商店」，也仍然有名字/图标/版本可以看。
  const ranked = found
    .map((a) => ({ a, rel: relevance(a.name, term) }))
    .sort((x, y) => y.rel - x.rel)
    .slice(0, 3);

  const detailed = await Promise.all(
    ranked.map(async (row) => ({ ...row, d: await yybDetail(row.a.pkg).catch(() => null) }))
  );

  // 详情页失败不能把整条结果弄丢：搜索页已经给了名字、图标和版本，
  // 少了直链只是少一个下载按钮，卡片仍然值得展示（可以点「去商店」）。
  // 之前这里 filter 掉 d 为空的条目，应用宝详情超时的时候「抖音」整条都能消失
  return detailed.map(({ a, rel, d }) => {
    const version = (d && d.version) || a.version;
    const size = (d && d.size) || a.size;
    const filename = `${a.pkg}-${version || 'app'}.apk`;
    return {
      id: `yyb:${a.pkg}`,
      name: (d && d.name) || a.name,
      publisher: (d && d.publisher) || a.publisher,
      packageId: a.pkg,
      version,
      icon: a.icon || (d && d.icon),
      summary: a.intro || (d && d.intro),
      tags: [a.pkg],
      platforms: ['android'],
      meta: [version ? `v${version}` : '', fmtSize(size)].filter(Boolean),
      rating: d && d.rating > 0 ? { score: Number(d.rating.toFixed(1)), count: d.ratingCount } : null,
      price: '免费',
      // 搜索页的 syzs_download_num 实测恒为 "0"（只有 PC 版游戏会给），
      // 真正的累计下载量在详情页的 downCount.bytes，微信是 89 亿次。
      // 拿不到时留空，让它退到「源内名次」的保底分，别用 0 冒充没人用
      pop: (d && d.downloads) || a.pop,
      popUnit: 'install',
      updated: a.updated,
      source: '应用宝',
      sourceUrl: `https://sj.qq.com/appdetail/${a.pkg}`,
      // 应用宝给了整包 MD5，下完能自己核一遍，比单纯“来自官方商店”更有说服力
      trust: d && d.md5 ? `MD5 ${d.md5.slice(0, 8)}…` : '',
      rel,
      downloads: d && d.apkUrl
        ? [
            {
              label: `${filename}（应用宝）`,
              short: `应用宝 · v${version || '?'}`,
              url: d.apkUrl,
              kind: 'direct',
              platform: 'android',
              size: fmtSize(size),
              filename,
            },
          ]
        : [],
    };
  });
}

/* ------------------------------------------------------------------ */
/* 数据源：Google Play（本机 Python 旁路，用你自己的账号取原包）          */
/* ------------------------------------------------------------------ */

/**
 * Play 网页搜索只给包名/标题/图标，版本和体积要等下载时才由 gpapi 解析，
 * 所以这里 version 留空——mergeAndroid 会让「没有版本」的一方不抢主卡片位。
 */
async function googlePlaySource(term) {
  if (!(await gplay.isUp())) return [];

  const rows = await gplay.search(term);
  return rows.slice(0, 8).map((r) => ({
    id: `play:${r.package}`,
    name: r.title || r.package,
    packageId: r.package,
    version: '',
    icon: r.icon || '',
    platforms: ['android'],
    meta: ['Play 原版'],
    price: '免费',
    source: 'Google Play',
    sourceUrl: `https://play.google.com/store/apps/details?id=${r.package}`,
    trust: 'Play 官方签名',
    downloads: [
      {
        label: `${r.package}.apk（Play 原版，分包合并）`,
        short: 'Play 原版',
        // 不是真 URL：前端识别成 play: 前缀后走 /api/play/prepare 那条异步链路，
        // 因为要先在服务端下载 base+splits、合并、重签名才能给出文件。
        url: `play:${r.package}`,
        kind: 'play',
        platform: 'android',
        filename: `${r.package}.apk`,
      },
    ],
  }));
}

/* ------------------------------------------------------------------ */
/* 数据源 4：GitHub Releases（开源桌面 / 安卓应用，可直接下载安装包）    */
/* ------------------------------------------------------------------ */

const SKIP_ASSET = /\.(sha256|sha512|sha1|md5|sig|asc|pem|txt|json|yml|yaml|blockmap|sbom|intoto\.jsonl)$/i;

function platformOfAsset(name) {
  const n = name.toLowerCase();
  if (/\.(exe|msi|msix)$/.test(n)) return 'windows';
  if (/\.(dmg|pkg)$/.test(n)) return 'macos';
  if (/\.(apk|aab)$/.test(n)) return 'android';
  if (/\.(appimage|deb|rpm|snap|flatpak)$/.test(n)) return 'linux';
  if (/\.(zip|7z|tar\.gz|tgz)$/.test(n)) {
    if (/(win|windows|x64|amd64)/.test(n)) return 'windows';
    if (/(mac|darwin|osx|universal)/.test(n)) return 'macos';
    if (/(linux|arm64|aarch64)/.test(n)) return 'linux';
    return 'archive';
  }
  return null;
}

const PLATFORM_ORDER = ['windows', 'macos', 'android', 'linux', 'archive'];

const PLATFORM_CN = {
  windows: 'Windows',
  macos: 'macOS',
  android: 'Android',
  linux: 'Linux',
  archive: '压缩包',
};

const ASSET_KIND = {
  exe: '安装包',
  msi: '安装包',
  msix: '安装包',
  dmg: '磁盘映像',
  pkg: '安装包',
  apk: 'APK',
  appimage: 'AppImage',
  deb: 'deb',
  rpm: 'rpm',
  zip: '压缩包',
  '7z': '压缩包',
  gz: '压缩包',
  tgz: '压缩包',
};

/** 把 OBS-Studio-32.2.2-Windows-x64-Installer.exe 这类长文件名压成人能读的短标签 */
function assetLabel(name, platform) {
  const n = name.toLowerCase();
  const arch = /aarch64|arm64|apple.?silicon/.test(n)
    ? 'arm64'
    : /(x86_64|x64|amd64)/.test(n)
      ? 'x64'
      : /(i386|x86|ia32|32bit)/.test(n)
        ? 'x86'
        : /universal/.test(n)
          ? 'universal'
          : '';
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  const kind = ASSET_KIND[ext.toLowerCase()] || (ext ? ext.toUpperCase() : '');
  return [PLATFORM_CN[platform] || '', arch, kind].filter(Boolean).join(' · ');
}

const releaseCache = new Map(); // full_name -> { at, data, err }
const RELEASE_TTL = 30 * 60 * 1000;
const MAX_RELEASE_CACHE = 100;

function trimMap(map, max) {
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

/** 取最新 release；按仓库缓存，避免每次搜索都打 GitHub core API（未认证只有 60 次/小时） */
async function latestRelease(fullName, headers) {
  const hit = releaseCache.get(fullName);
  if (hit && Date.now() - hit.at < RELEASE_TTL) {
    if (hit.err) throw hit.err;
    return hit.data;
  }
  try {
    const data = await fetchJson(
      `https://api.github.com/repos/${fullName}/releases/latest`,
      { headers, timeout: 7000 }
    );
    releaseCache.set(fullName, { at: Date.now(), data });
    trimMap(releaseCache, MAX_RELEASE_CACHE);
    return data;
  } catch (e) {
    if (e.status === 404) {
      releaseCache.set(fullName, { at: Date.now(), data: null });
      trimMap(releaseCache, MAX_RELEASE_CACHE);
      return null;
    }
    releaseCache.set(fullName, { at: Date.now(), err: e });
    trimMap(releaseCache, MAX_RELEASE_CACHE);
    throw e;
  }
}

async function githubSource(term) {
  const token = await ghToken();
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const search = await fetchJson(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(term + ' in:name')}` +
      `&sort=stars&order=desc&per_page=8`,
    { headers }
  );

  const repos = (search.items || []).slice(0, 2);
  const errors = [];

  const cards = await Promise.all(
    repos.map(async (repo) => {
      let release;
      try {
        release = await latestRelease(repo.full_name, headers);
      } catch (e) {
        errors.push(e);
        return null;
      }
      if (!release) return null;
      const assets = (release.assets || []).filter((a) => !SKIP_ASSET.test(a.name));
      if (!assets.length) return null;

      const downloads = assets
        .map((a) => {
          const platform = platformOfAsset(a.name) || 'archive';
          return {
            label: a.name,
            short: assetLabel(a.name, platform),
            url: a.browser_download_url,
            kind: 'direct',
            platform,
            size: fmtSize(a.size),
            filename: a.name,
          };
        })
        .sort(
          (a, b) =>
            PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform) ||
            b.size.length - a.size.length
        )
        .slice(0, 8);

      const platforms = [...new Set(downloads.map((d) => d.platform))].filter(
        (p) => p !== 'archive'
      );

      return {
        id: `github:${repo.full_name}`,
        name: repo.name,
        publisher: repo.owner?.login || '',
        icon: repo.owner?.avatar_url || '',
        summary: repo.description || '',
        tags: [release.tag_name, repo.language].filter(Boolean),
        platforms: platforms.length ? platforms : ['archive'],
        meta: [
          release.tag_name || '',
          `★ ${fmtNum(repo.stargazers_count)}`,
          repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : '',
        ].filter(Boolean),
        rating: null,
        price: '开源',
        pop: repo.stargazers_count || 0,
        // star 数和下载量不是一个概念，量级也差得远，单独给一把尺子
        popUnit: 'stars',
        updated: release.published_at || repo.pushed_at || '',
        source: 'GitHub Releases',
        sourceUrl: repo.html_url,
        downloads,
      };
    })
  );

  const ok = cards.filter(Boolean);
  if (!ok.length && errors.some((e) => e.status === 403 || e.status === 429)) {
    throw new Error('GitHub 限流：匿名每小时 60 次，`gh auth login` 后可到 5000');
  }
  return ok;
}

/* ------------------------------------------------------------------ */
/* 数据源 5：Steam（PC 游戏，Windows / macOS / Linux）                   */
/* ------------------------------------------------------------------ */

async function steamSource(term) {
  const data = await fetchJson(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}` +
      `&l=schinese&cc=CN`,
    { timeout: 8000 }
  );
  return (data.items || []).slice(0, 6).map((i) => {
    const platforms = [];
    if (i.platforms?.windows) platforms.push('windows');
    if (i.platforms?.mac) platforms.push('macos');
    if (i.platforms?.linux) platforms.push('linux');
    const price = i.price
      ? `${i.price.currency === 'CNY' ? '¥' : i.price.currency + ' '}${(i.price.final / 100).toFixed(2)}`
      : '免费';
    return {
      id: `steam:${i.id}`,
      name: i.name,
      publisher: 'Steam',
      icon: i.tiny_image || '',
      summary: '',
      tags: i.metascore ? [`Metascore ${i.metascore}`] : [],
      platforms: platforms.length ? platforms : ['windows'],
      meta: [],
      rating: null,
      price,
      pop: 0,
      updated: '',
      source: 'Steam',
      sourceUrl: `https://store.steampowered.com/app/${i.id}/`,
      downloads: [
        {
          label: 'Steam 商店页',
          url: `https://store.steampowered.com/app/${i.id}/`,
          kind: 'store',
          platform: platforms[0] || 'windows',
        },
      ],
    };
  });
}

/* ------------------------------------------------------------------ */
/* 兜底深链：没有公开 API 的平台                                       */
/* ------------------------------------------------------------------ */

function deepLinks(q) {
  const e = encodeURIComponent(q);
  return [
    { platform: 'android', label: 'Google Play', url: `https://play.google.com/store/search?q=${e}&c=apps`, note: '官方商店，需 Google 服务' },
    { platform: 'android', label: 'APKPure', url: `https://apkpure.com/search?q=${e}`, note: '第三方 APK 镜像' },
    { platform: 'android', label: 'APKMirror', url: `https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=${e}`, note: '第三方 APK 镜像' },
    { platform: 'android', label: '应用宝', url: `https://sj.qq.com/search?q=${e}`, note: '腾讯官方商店' },
    { platform: 'android', label: '华为应用市场', url: `https://appgallery.huawei.com/search/${e}`, note: '华为官方商店' },
    { platform: 'ios', label: 'App Store 搜索', url: `https://apps.apple.com/cn/search?term=${e}`, note: 'iOS 唯一官方渠道' },
    { platform: 'windows', label: 'Microsoft Store', url: `https://apps.microsoft.com/search?query=${e}`, note: '微软官方商店' },
    { platform: 'windows', label: 'Steam 搜索', url: `https://store.steampowered.com/search/?term=${e}`, note: 'PC 游戏' },
    { platform: 'linux', label: 'Flathub', url: `https://flathub.org/apps/search?q=${e}`, note: 'Linux 沙盒应用' },
    { platform: 'archive', label: 'GitHub 全站搜索', url: `https://github.com/search?q=${e}&type=repositories`, note: '源码与 Release' },
  ];
}

/* ------------------------------------------------------------------ */
/* 聚合                                                                */
/* ------------------------------------------------------------------ */

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();
const inflight = new Map();
const MAX_SEARCH_CACHE = 100;
const MAX_INFLIGHT_SEARCHES = 100;

// 单个源最多等这么久：聚合是 Promise.all，一个源卡住就会拖死整次搜索。
// 20s 是「慢但不死」和「别干等」之间的折中：正常链路上最慢的 Play 约 8s，
// 但出口一抖动整条链路会集体掉到 10s 级，12s 的旧值会把还能用的源直接判死
// （实测有过一次 iOS/Play 同时 12001ms 超时，而其余源都在 9~11s 才回来）。
const SOURCE_TIMEOUT = 20000;

// 源失败的聚合结果只缓存这么久：网络抖一下不该让这个词在 10 分钟里一直是红的
const STALE_CACHE_TTL = 45 * 1000;

async function runSource(name, fn, timeoutMs = SOURCE_TIMEOUT) {
  const t0 = Date.now();
  const controller = new AbortController();
  let timer;
  try {
    const task = Promise.resolve().then(() => runWithRequestContext(controller.signal, fn));
    const items = await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error(`超时（>${timeoutMs / 1000}s，代理与直连都没响应）`));
          },
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
    return { name, ok: true, ms: Date.now() - t0, count: items.length, items };
  } catch (e) {
    const error = e.status ? `HTTP ${e.status}` : String(e.message || e);
    // 源失败必须留痕：UI 上只有一个红点，事后想知道「是超时、被墙还是接口改版」
    // 只能翻日志，所以这里把源名、耗时、原因都打出来
    console.warn(`[源失败] ${name} ${Date.now() - t0}ms ${error}`);
    return { name, ok: false, ms: Date.now() - t0, count: 0, items: [], error };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// 每个数据源内部按相关度重排，并丢掉明显不相关的噪声
const CAP = {
  'iOS App Store': 6,
  'Homebrew Cask': 6,
  'Mac App Store': 3,
  应用宝: 6,
  'Google Play': 5,
  Aptoide: 6,
  'F-Droid': 4,
  IzzyOnDroid: 4,
  'GitHub Releases': 2,
  Winget: 5,
  Snapcraft: 4,
  Flathub: 4,
  Steam: 5,
};

// 带关键词索引的商店源。它们的「推荐位兜底」很危险（会把一堆无关应用塞进来），
// 所以名字对不上时最多只留它自己的第一名，不再批量兜底——细节见 pickItems。
const STRICT = new Set([
  '应用宝',
  'Aptoide',
  'Google Play',
  'F-Droid',
  'IzzyOnDroid',
  'Winget',
  'Snapcraft',
  'Flathub',
]);

// 表驱动：聚合和「单个失败源补跑」都从这里取，避免两处逻辑走偏
const SOURCE_DEFS = [
  ['iOS App Store', (q, ctx) => appleSearch(q, 'software', ctx.store)],
  ['Homebrew Cask', (q) => homebrewSource(q)],
  ['Mac App Store', (q, ctx) => appleSearch(q, 'macSoftware', ctx.store)],
  ['应用宝', (q) => yybSource(q)],
  ['Google Play', (q) => googlePlaySource(q)],
  ['Aptoide', (q) => aptoideSource(q)],
  ['F-Droid', (q) => fdroid.source(q, { relevance })],
  ['IzzyOnDroid', (q) => izzy.source(q, { relevance })],
  ['GitHub Releases', (q) => githubSource(q)],
  ['Winget', (q) => winget.source(q, { relevance })],
  ['Snapcraft', (q) => snapcraft.source(q, { relevance })],
  ['Flathub', (q) => flathub.source(q, { relevance })],
  ['Steam', (q) => steamSource(q)],
];

/** 单源的相关度排序 + 截断：聚合各源共用同一套规则，结果才可复现 */
// 弱匹配名额只给「结果本来就少」的源：一次吐二十几条的一定在拿推荐位充数
const WEAK_MAX_RAW = 8;

function pickItems(name, items, q) {
  // 数据源自己算过相关度的（比如 Homebrew 命中中文别名）就用它的，否则按名字算
  const ranked = items
    .map((item) => ({ item, rel: item.rel != null ? item.rel : relevance(item.name, q) }))
    .sort((a, b) => b.rel - a.rel);

  const strong = ranked.filter((x) => x.rel > 0);
  // rel 必须跟着条目一起走到聚合层：最终排序要靠它分档，热度只在同档内决胜。
  // 这里丢掉 rel 的话，排序就只剩热度，搜「微信」会被「微信读书」这类大热的旁支顶上去。
  if (strong.length) return strong.slice(0, CAP[name] || 6).map((x) => ({ ...x.item, rel: x.rel }));

  // 名字一个都没对上。这里原来对商店源直接返回空，代价是**整块结果消失**：
  // 微信在 Play 上的正式名就叫 WeChat、原神叫 Genshin Impact，本地子串比较永远对不上，
  // 于是搜中文名时 Google Play 一条都不剩，连带安卓卡全没了。
  //
  // 但商店是按关键词搜的，它排第一的结果本身就是一种匹配证据，比我们的子串判断更可信
  // （Google 知道「微信」和 WeChat 是同一个 App，我们不知道）。所以保留**它自己的第一名**，
  // 只保留一条，并打上 weak 标记——聚合完后会被排到所有文字命中之后，
  // 不至于让「搜微信」冒出 LINE、KakaoTalk 这种推荐位噪声。
  //
  // 另一个门槛是 WEAK_MAX_RAW：App Store 这类源一次能吐二十几条，说明它是在拿推荐位
  // 充数（搜「原神」，Mac App Store 的第一名是「微信」），这种源一律不给弱匹配名额。
  // 只有「结果本来就少」的源才可信——那种时候它确实是在说「我只找到这一个」。
  if (STRICT.has(name) && items.length <= WEAK_MAX_RAW) {
    return ranked.slice(0, 1).map((x) => ({ ...x.item, rel: x.rel, weak: true }));
  }
  if (STRICT.has(name)) return [];

  // 非商店源（Steam / GitHub / Homebrew）没有关键词索引，只能拿推荐位兜底
  return ranked.filter((x) => x.rel === 0).slice(0, 4).map((x) => ({ ...x.item, rel: 0, weak: true }));
}

/** 把条目并进已有结果集（去重键与聚合时一致） */
function absorb(items, results, seen) {
  items.forEach((item, i) => {
    const key = `${item.source}:${item.name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    // 源内名次：这个源自己认为它排第几。Play / Winget / F-Droid 完全不提供热度，
    // 排序时只能拿它当保底分（见 heatScore），否则整块源会一起沉到最底下
    if (item.srcRank == null) item.srcRank = i;
    // 标记是否真的能直下，UI 用它区分「下载」和「去商店」
    // Play 算直下：授权一次之后长期可用，只是第一次要先登录
    item.direct = (item.downloads || []).some((d) => d.kind === 'direct' || d.kind === 'play');
    results.push(item);
  });
}

async function aggregate(q, { store = DEFAULT_STORE } = {}) {
  const ctx = { store };
  const sources = await Promise.all(
    SOURCE_DEFS.map(([name, fn]) => runSource(name, () => fn(q, ctx)))
  );

  const seen = new Set();
  const results = [];
  for (const s of sources) absorb(pickItems(s.name, s.items, q), results, seen);

  // 文字命中的排前面，商店「说它匹配但名字对不上」的排后面。
  // sort 在 Node 里是稳定的，所以同组内保持各源原有顺序。
  results.sort((a, b) => Number(Boolean(a.weak)) - Number(Boolean(b.weak)));

  const merged = mergeAndroid(results);

  // APKPure 没有可用的关键词搜索接口，只能按包名查。
  // 合并完之后包名已经有了，顺手给最靠前的几张 Android 卡片多挂一条直链：
  // 应用宝没有的国际应用、Aptoide 没收录的国内应用，经常正好在这里补上。
  //
  // 先按现有热度粗排一次，让 APKPure 的补点优先落在最可能热门的卡片上——
  // 它一次只查 5 个包名，撒在冷门结果上等于白花这 5 次往返。
  rankByHeat(merged);
  await apkpure.enrich(merged, { limit: 8 });
  for (const r of merged) {
    promoteNewest(r);
    r.direct = (r.downloads || []).some((d) => d.kind === 'direct' || d.kind === 'play');
    // 顺手记下「包名 → 应用名」。下载队列里显示的就是这个表——
    // 不然下完只剩 com.sanjie.sipor_6759524779_1.1.5.ipa，用户认不出是「奶茶人」
    appNames.remember(r.bundleId || r.packageId, r.name);
  }

  // APKPure 可能刚补上了下载量，重排一次：这一步才是最终顺序
  rankByHeat(merged);

  return {
    query: q,
    store: store === ALL_STORES ? ALL_STORES : APPLE_STORES[store] ? store : DEFAULT_STORE,
    results: merged,
    directCount: merged.filter((r) => r.direct).length,
    sources: sources.map(({ items, ...rest }) => rest),
    deepLinks: deepLinks(q),
  };
}

/** 8.0.79 / 40.7.0 / 9.50.0 这类版本号按数字段比大小 */
function versionParts(v) {
  return String(v || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((n) => Number(n) || 0);
}

function cmpVersion(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * 补完 APKPure 之后可能出现「卡片写 v7.5.2，但它那边已经有 v10.2.0」的情况。
 * 版本号和主按钮都得跟着新的走，否则用户以为下到的是最新版。
 * 唯一的例外是 Play 原版：它按钮上有官方签名和分包合并，不该被第三方镜像挤下去。
 */
function promoteNewest(item) {
  const ds = item.downloads || [];
  const ap = ds.find((d) => d.origin === 'apkpure' && d.version);
  if (!ap) return;

  const cur = String(item.version || '').trim();
  const setMeta = () => {
    if (String(item.meta?.[0] || '').startsWith('v')) item.meta[0] = `v${ap.version}`;
  };

  if (!cur) {
    item.version = ap.version;
    setMeta();
    return;
  }
  if (cmpVersion(ap.version, cur) <= 0) return;

  item.version = ap.version;
  setMeta();
  if ((ds[0] || {}).kind !== 'play') item.downloads = [ap, ...ds.filter((d) => d !== ap)];
}

/**
 * 同一个包在应用宝和 Aptoide 都有时，UI 上应该是一张卡片、两个下载按钮，
 * 而不是两张看起来差不多的卡片。版本新的那个当主卡片，另一个降级成备选按钮。
 */
function mergeAndroid(results) {
  const byPkg = new Map();
  const out = [];

  for (const item of results) {
    const isAndroid = (item.platforms || []).includes('android');
    const pkg = isAndroid ? item.packageId : '';

    if (!pkg) {
      out.push(item);
      continue;
    }

    item.sources = [item.source];
    const hit = byPkg.get(pkg);

    if (!hit) {
      byPkg.set(pkg, { item, index: out.length });
      out.push(item);
      continue;
    }

    const prev = hit.item;
    // 没有版本号的一方（Play 网页搜索不给版本）不抢主卡片位，
    // 否则空版本会被 cmpVersion 当成 0.0.0 直接判负，把真实版本挤到备选里
    const prevHasV = Boolean(String(prev.version || '').trim());
    const itemHasV = Boolean(String(item.version || '').trim());
    const prevIsNewer = prevHasV === itemHasV ? cmpVersion(prev.version, item.version) >= 0 : prevHasV;
    const primary = prevIsNewer ? prev : item;
    const secondary = prevIsNewer ? item : prev;

    primary.sources = [...new Set([...prev.sources, ...item.sources])];

    // 相关度取两边更高的：一张卡能合并，说明两个源都认这个包，其中一边判断得更准
    // （比如 Play 的英文名对中文关键词得 0 分，而应用宝的「微信」是 100 分）
    primary.rel = Math.max(Number(prev.rel) || 0, Number(item.rel) || 0);

    // 热度同理取高的那一边。单位可能不同（Play 没有热度，APKPure 有下载量），
    // 所以按算出来的分数比，而不是比原始数字。
    const prevHeat = heatOf(prev);
    const itemHeat = heatOf(item);
    if ((itemHeat?.score || -1) > (prevHeat?.score || -1)) {
      primary.pop = item.pop;
      primary.popUnit = item.popUnit;
      primary.popLabel = item.popLabel;
      primary.popFrom = item.popFrom;
    } else if (prevHeat) {
      primary.pop = prev.pop;
      primary.popUnit = prev.popUnit;
      primary.popLabel = prev.popLabel;
      primary.popFrom = prev.popFrom;
    }

    // 同一份文件可能在两个源都出现，按 URL 去重；保留主卡片原来的按钮顺序
    const downloads = [...(primary.downloads || [])];
    for (const d of secondary.downloads || []) {
      if (!downloads.some((x) => x.url === d.url)) downloads.push(d);
    }
    primary.downloads = downloads;
    primary.direct = downloads.some((d) => d.kind === 'direct');

    if (!prevIsNewer) {
      hit.item = item;
      out[hit.index] = item;
    }
  }

  return out;
}

/**
 * 名字相关度。分层要细，否则「Google Chrome」会被「Chrome Remote Desktop」压住——
 * 两者都是整词命中，应该打平，再让装机量/评分决定谁在前。
 */
function relevance(name, q) {
  const n = String(name || '').toLowerCase().trim();
  const t = String(q || '').toLowerCase().trim();
  if (!n || !t) return 0;
  if (n === t) return 100;

  const words = n.split(/[\s\-_·:：,，()（）[\]/]+/).filter(Boolean);
  if (words.includes(t)) return 92;
  if (n.startsWith(t)) return 88;
  if (words.some((w) => w.startsWith(t))) return 84;
  if (n.includes(t)) return 60;

  const toks = t.split(/\s+/).filter(Boolean);
  if (toks.length > 1 && toks.every((x) => n.includes(x))) return 45;
  return 0;
}

/* ------------------------------------------------------------------ */
/* 热度：把不同源的不同指标压成同一把尺子                                */
/* ------------------------------------------------------------------ */

/**
 * 各源给的「热度」根本不是同一个东西：
 *   应用宝 / Aptoide / APKPure / Flathub → 下载量（或月安装）
 *   App Store → 评分人数
 *   GitHub → star 数
 * 量纲差五六个数量级，直接相加没有意义——一个 100 人评分的小工具会赢过 800 万下载的应用。
 *
 * 所以统一压到 0~100 的对数刻度上，每个指标给自己的参考区间：下界以下记 0 分，
 * 上界以上记 100 分。换算关系按经验取：应用评分率大约百分之一，所以「N 人评分」
 * 约等于「100N 次下载」，rating 的区间因此比 install 少两个数量级。
 *
 * 上界取 100 亿而不是 10 亿：应用宝给的是全渠道累计下载（微信 200 亿+），
 * 封在 10 亿会让所有国民级应用并列 100 分，排序就退化成随机了。
 */
const HEAT_SCALE = {
  install: [3, 10], // 1 千 ~ 100 亿次下载
  rating: [1, 8], // 10 ~ 1 亿人评分（≈ 1 千 ~ 100 亿次下载）
  stars: [1, 5], // 10 ~ 10 万 star
};
const HEAT_LABEL = { install: '次下载', rating: '人评分', stars: 'star' };

/**
 * star 要再打个折。
 *
 * 3 万 star 在 star 刻度上是 87 分，可那只代表「一批开发者在关注」，
 * 对应的用户规模远小于 1 亿次下载。不打折的话，搜 telegram 时
 * GitHub 上的 python-telegram-bot 会压过 Telegram 本体（3 家商店同名收录）。
 * 折半之后它仍然能在「只有 GitHub 收录」的开发工具里当主证据。
 */
const HEAT_WEIGHT = { stars: 0.5 };

/** 把一条结果的热度算成 0~100；没有热度数据返回 null，不要拿 0 分冒充「没人用」 */
function heatOf(item) {
  const value = Number(item.pop) || 0;
  if (value <= 0) return null;
  const unit = HEAT_SCALE[item.popUnit] ? item.popUnit : 'install';
  const [lo, hi] = HEAT_SCALE[unit];
  const ratio = (Math.log10(value) - lo) / (hi - lo);
  const score = Math.round(Math.max(0, Math.min(1, ratio)) * 100 * (HEAT_WEIGHT[unit] || 1));
  // popLabel 用于口径不是「累计下载」的源（Flathub 给的是月安装），
  // 不写清楚会被当成全量下载量，16.9 万和 200 亿摆在一起会显得很怪
  const label = item.popLabel || HEAT_LABEL[unit];
  return {
    score,
    value,
    unit,
    // 有 popFrom 说明这个数字不是主源自己给的（典型：APKPure 补进应用宝卡片），
    // 悬停提示要写清楚，不然会被当成那个商店的统计口径
    from: item.popFrom || item.source || '',
    text: `${fmtNum(value)}${label}`,
  };
}

/**
 * 相关度分档。
 *
 * 不能直接把 rel 当排序主键：搜「chrome」时 Aptoide 上有个壁纸应用名字就叫「Chrome」
 * （rel 100），它会把真正的「Google Chrome」（rel 92，20 亿下载）挤到第三位——
 * 名字完全等于关键词，并不能证明它就是用户要的东西，热度才是那个证据。
 *
 * 所以只保留三条硬边界，同档内交给热度：
 *   2 = 名字完全等于 / 整体以关键词开头 / 含关键词整词（100 / 92 / 88）
 *   1 = 名字里包含关键词，或多个词分别命中（84 / 60 / 45）
 *   0 = 文字完全没对上
 *
 * 88 和 84 之间必须划一刀，但 100 / 92 / 88 之间不能划：
 * 前者区分「抖音极速版」和「剪映 - 抖音官方AI创作神器」——一个是同一产品线的版本，
 * 一个只是顺带提到；后者如果也切开，壁纸应用就能靠同名压住正主。
 */
function relBand(rel) {
  const r = Number(rel) || 0;
  if (r >= 88) return 2;
  if (r >= 45) return 1;
  return 0;
}

/**
 * 排序用的分数。有真实热度就用热度；没有的话退到「源内名次」折一个保底分。
 *
 * 保底分不是装饰：Play、Winget、F-Droid、Snapcraft 都不提供下载量，如果一律当 -1，
 * 搜「微信」时 Google Play 那张卡会掉到十几张冷门结果后面。
 *
 * 上限压到 25（≈ 3 千次下载的水平）是有意的：再高就会盖过真数据——
 * 实测 Flathub 的 Google Chrome 有 16.9 万月安装（32 分），
 * 设成 35 的话会被 Steam 里一个同名游戏（纯保底分）压住。
 */
function heatScore(item) {
  if (item.heat && item.heat.score > 0) return item.heat.score;
  // 有热度数据但算出来是 0（下载量低于刻度下界）是**确定的结论**：这东西没人用。
  // 不能让它掉进下面的保底分——那样「730 次下载」会和「不知道下载量」拿一样的分，
  // 微信输入法在 Homebrew 上的 730 次下载就会因此排到 50 万下载的微信读书前面
  if (item.heat) return 0;
  const rank = Number(item.srcRank);
  return Number.isFinite(rank) ? Math.max(4, 25 - rank * 4) : -1;
}

/** 名字归一化：只留字母数字（含中文），用来判断「这几个结果是不是同一个名字」 */
function normName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 同名条目被几家独立商店收录。
 *
 * 这是排序里唯一一个不依赖量纲的证据，用来解决「同档内该信谁」：
 *   - 搜 chrome，Aptoide 有个壁纸应用名字就叫「Chrome」，下载量不低；
 *   - 搜 figma，Aptoide 的「Figma Mirror」有 500 万下载，评分却只有 5.4k 人——
 *     一个下载量、一个评分人数，两者根本不可比，谁高谁低纯属巧合。
 * 但「Google Chrome」在 Aptoide / App Store / Flathub / Homebrew / Winget 同名收录，
 * 「Figma」在 App Store / Winget / Homebrew 都有，而壁纸 Chrome 和 Figma Mirror
 * 只在 Aptoide 一家出现。多家独立商店都认这个名字，才说明它是用户要找的正主。
 *
 * 只数 rel >= 45 的条目：文字没对上的东西名字相同也只是巧合。
 */
function nameSupport(results) {
  const map = new Map();
  for (const r of results) {
    if (r.weak) continue;
    if ((Number(r.rel) || 0) < 45) continue;
    const key = normName(r.name);
    if (!key) continue;
    if (!map.has(key)) map.set(key, new Set());
    // 用主源计数，不用 sources：APKPure 会给合并卡片补下载量，
    // 拿 sources 计数等于让「被补过点的卡片」凭空多一票
    map.get(key).add(r.source);
  }
  for (const r of results) {
    r.support = map.get(normName(r.name))?.size || 0;
  }
}

/**
 * 最终排序用的分数：热度 + 同名跨店收录的有限加分。
 *
 * 加分不能当主排序键。搜「抖音」时「抖音聊天」在 Winget 和 Homebrew 都有，
 * 收录数 2 比「抖音极速版」的 1 高，可它只有 10 次下载——真拿收录数排序，
 * 一个刚发布的小工具就能压住 982 万人评分的极速版。
 *
 * 所以收录数只折算成有限的加分（每多一家商店 +15，封顶 +45）：
 *   - 搜 chrome：Google Chrome 在 5 家商店同名收录（+45），
 *     即使 Aptoide 上那个同名的壁纸应用有 485 万下载也压不过它；
 *   - 搜 figma：Figma 在 3 家店收录（+30），把单店 500 万下载的 Figma Mirror 顶下去；
 *   - 搜抖音：极速版热度 86 分，抖音聊天只有 12 分，+15 也翻不了盘。
 * 封顶 45 是刻意的：再高，冷门应用靠同名就能挤进前排。
 */
function rankScore(item) {
  const bonus = Math.min(45, 15 * Math.max(0, (item.support || 0) - 1));
  // 名字完全等于关键词再加 20，但要求「至少有别家商店也这么叫」。
  // 只有一家店叫这个名字时，完全同名反而更像重名的小应用：Aptoide 上那个壁纸应用
  // 就叫 Chrome（485 万下载），给它加 20 分会挤到 Homebrew 的 Google Chrome 前面。
  // 需要这 20 分是因为「同名变体」经常有虚高的下载量：Telegram X 在 Aptoide 上写着 1 亿次，
  // 而 Telegram 本体只有 8.9 万（源数据本身就错），光靠热度会把变体排到本体前面。
  const exact = (Number(item.rel) || 0) >= 100 && (item.support || 0) >= 2 ? 20 : 0;
  return heatScore(item) + bonus + exact;
}

/**
 * 最终排序：弱匹配垫底 → 相关度分档 → 分数（热度 + 同名加分）→ 原来的顺序。
 *
 * 弱匹配放在最前面判，是因为商店的弱匹配是「它自己搜出来的第一名」，
 * 可能是完全不相干的东西（搜「原神」，Mac App Store 的第一名是微信），
 * 那种条目就算是全球最热的应用也不该排在有文字命中的结果前面。
 */
function rankByHeat(results) {
  for (const r of results) r.heat = heatOf(r);
  nameSupport(results);
  results.sort((a, b) => {
    const w = Number(Boolean(a.weak)) - Number(Boolean(b.weak));
    if (w) return w;
    const rb = relBand(b.rel) - relBand(a.rel);
    if (rb) return rb;
    const rs = rankScore(b) - rankScore(a);
    if (rs) return rs;
    // 完全打平时 sort 是稳定的，保持各源原来的相对顺序
    return heatScore(b) - heatScore(a);
  });
  return results;
}

async function searchCached(q, { fresh = false, store = DEFAULT_STORE } = {}) {
  // 缓存键必须带区：同一个词在中国区和美国区搜出来的 App Store 结果是两套
  const key = `${store}:${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < hit.ttl) {
    return { ...hit.payload, cached: true };
  }
  if (inflight.has(key)) return inflight.get(key);
  if (inflight.size >= MAX_INFLIGHT_SEARCHES) {
    throw new Error('搜索任务过多，请稍后重试');
  }

  const p = aggregate(q, { store })
    .then((payload) => {
      // 有源挂掉就只缓存很短时间。否则一次网络抖动会让这个词在 10 分钟里
      // 一直顶着「全部不可用」，用户重搜也还是那份坏的缓存（实测踩过）。
      const failed = payload.sources.filter((s) => !s.ok).length;
      cache.set(key, {
        at: Date.now(),
        payload,
        ttl: failed ? STALE_CACHE_TTL : CACHE_TTL,
      });
      trimMap(cache, MAX_SEARCH_CACHE);
      if (inflight.get(key) === p) inflight.delete(key);
      return { ...payload, cached: false };
    })
    .catch((e) => {
      if (inflight.get(key) === p) inflight.delete(key);
      throw e;
    });

  inflight.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ */
/* 本地直下后端：调用本机已装的 CLI，拿到商店里才有的安装包              */
/* ------------------------------------------------------------------ */

const DOWNLOAD_DIR = path.join(__dirname, '.downloads');
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');

// 包名 → 应用名 的本地字典。必须赶在 restoreQueueFromDisk() 之前加载：
// 恢复清单时手上只有文件名，没有这张表就只能显示 com.sanjie.sipor 这种包名
appNames.init(path.join(__dirname, '.cache', 'app-names.json'));

// 队列把文件落到 .downloads，和 ipatool / apkeep 的产物同一个目录，
// 这样「下载 → 装到设备」和「本机工具下载 → 装到设备」是同一条路径
const downloadQueue = new DownloadQueue({ dir: DOWNLOAD_DIR, validateUrl: assertPublicUrl });

/* ------------------------------------------------------------------ */
/* AI 接入：MCP 工具                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把「搜索 → 下载 → 装到设备」暴露成 MCP 工具，让 Claude Desktop / Cursor / Cherry Studio
 * 这类客户端不用 shell 也能用这个工具的完整能力。
 *
 * 工具名和参数一律 snake_case：MCP 客户端大多把参数名原样喂给模型，
 * 混着驼峰会让它写错键名。
 *
 * 描述写得长是有意的——模型只能靠这段文字决定「什么时候该调哪个」，
 * 「中文英文都能搜」「耗时 3~25 秒」「同一关键词 10 分钟走缓存」这些都得说清楚。
 */
const MCP_TOOLS = [
  {
    name: 'search_apps',
    description:
      '在一个搜索框里同时查 App Store（中/美/日/港/台全区）、Google Play、应用宝、Aptoide、F-Droid、' +
      'IzzyOnDroid、APKPure、Homebrew Cask、Winget、Snapcraft、Flathub、GitHub Releases，' +
      '返回可以直接下载的安装包链接（APK / IPA / dmg / exe / AppImage / snap 等）。' +
      '中文名和英文名都能搜：搜「微信」或「WeChat」都会命中同一应用在不同区的版本。' +
      '各源并发查询，慢源 20 秒超时即放弃，所以整体 3~25 秒；同一关键词 10 分钟内走缓存。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '应用名，中文或英文都行，例如「微信」「Genshin Impact」' },
        platform: {
          type: 'string',
          enum: ['all', 'android', 'ios', 'macos', 'windows', 'linux'],
          default: 'all',
          description: '只保留某个平台的结果，默认全部',
        },
        store: {
          type: 'string',
          enum: ['all', 'cn', 'us', 'jp', 'hk', 'tw'],
          default: 'all',
          description: 'App Store 的区，默认全区（同一个应用在不同区的名字和上架情况不一样）',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          default: 6,
          description: '最多返回几条，默认 6 条。结果多的时候按相关度排，前面的更准',
        },
        downloadable_only: {
          type: 'boolean',
          default: true,
          description: '只要带直链的（默认 true）。设 false 会包含只有商店页面的条目',
        },
      },
      required: ['query'],
    },
    handler: async (a) => {
      const q = String(a.query || '').trim();
      if (!q) throw new Error('query 不能为空');
      if (q.length > 60) throw new Error('query 太长（≤60 字）');

      const storeRaw = String(a.store || 'all').toLowerCase();
      const store = storeRaw === ALL_STORES || APPLE_STORES[storeRaw] ? storeRaw : ALL_STORES;
      // tookMs 是 /api/search 那层加的，searchCached 自己不带，这里单独计
      const t0 = Date.now();
      const payload = await searchCached(q, { store, fresh: false });
      const tookMs = Date.now() - t0;

      const plat = String(a.platform || 'all');
      const onlyDirect = a.downloadable_only !== false;
      const limit = Math.max(1, Math.min(20, Number(a.limit) || 6));

      let rows = Array.isArray(payload.results) ? payload.results : [];
      if (plat !== 'all') rows = rows.filter((r) => (r.platforms || []).includes(plat));
      if (onlyDirect) {
        rows = rows.filter((r) => (r.downloads || []).some((d) => d.url));
      }
      const total = rows.length;
      rows = rows.slice(0, limit);

      if (!rows.length) {
        const bad = (payload.sources || []).filter((s) => !s.ok);
        return (
          `没有匹配「${q}」的结果。\n` +
          (bad.length ? `这次没返回的源：${bad.map((s) => `${s.name}（${s.error || '失败'}）`).join('、')}\n` : '') +
          '建议：换个叫法再搜一次（中文名 / 英文名 / 包名都试试），或者把 platform 设成 all。'
        );
      }

      const lines = [];
      lines.push(
        `「${q}」命中 ${total} 个，列出前 ${rows.length} 个（${(tookMs / 1000).toFixed(1)}s，${payload.cached ? '缓存' : '实时'}）`
      );
      lines.push('');

      rows.forEach((r, i) => {
        const head = [`${i + 1}) ${r.name}`];
        if (r.version) head.push(`v${r.version}`);
        if (r.platforms?.length) head.push(r.platforms.join('/'));
        lines.push(head.join(' · '));

        // 热度写在第一项：列表就是按它排的，模型需要这个数来判断「哪个是正主」，
        // 「微信读书」和「微信」名字都命中，能区分的只有下载量
        const meta = [
          r.heat?.text ? `热度 ${r.heat.text}` : '',
          r.rating ? `★${r.rating.score}` : '',
          r.publisher,
          r.source,
          r.price,
          r.trust,
        ]
          .filter(Boolean)
          .join(' · ');
        if (meta) lines.push(`   ${meta}`);
        if (r.summary) lines.push(`   ${String(r.summary).replace(/\s+/g, ' ').slice(0, 90)}`);

        const ds = (r.downloads || []).filter((d) => d.url).slice(0, 3);
        for (const d of ds) {
          const tag = [d.short || d.label, d.size, d.platform].filter(Boolean).join(' · ');
          lines.push(`   ↓ ${tag}`);
          lines.push(`     ${d.url}`);
        }
        if (!ds.length && r.sourceUrl) lines.push(`   ↗ ${r.sourceUrl}`);
      });

      const bad = (payload.sources || []).filter((s) => !s.ok);
      if (bad.length) {
        lines.push('');
        lines.push(`没返回的源：${bad.map((s) => `${s.name}（${s.error || '失败'}）`).join('、')}`);
      }
      lines.push('');
      lines.push('要下载就调 download_package(url=<上面任意一条直链>)。');
      return lines.join('\n');
    },
  },

  {
    name: 'download_package',
    description:
      '把安装包下载到本机 .downloads 目录。走后台队列：支持断点续传、失败重试，' +
      '超过 6 MB 且服务器支持 Range 时会自动切成 4 段并发（单连接被限速时快很多）。' +
      '目录达到 10 GiB 时会拒绝新下载，不会自动删除已有文件。' +
      '立刻返回 job_id，不会等下载完；用 download_status 查进度。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '安装包直链，通常来自 search_apps 的结果' },
        filename: { type: 'string', description: '存成什么文件名，不填就用 URL 里的文件名' },
        title: { type: 'string', description: '应用名（如「微信」），用于在队列里显示得更好认' },
        platform: {
          type: 'string',
          enum: ['android', 'ios', 'macos', 'windows', 'linux'],
          description: '平台，决定后续能装到哪类设备',
        },
      },
      required: ['url'],
    },
    handler: async (a) => {
      const raw = String(a.url || '').trim();
      if (!raw) throw new Error('url 不能为空');

      let target;
      try {
        target = new URL(raw);
      } catch {
        throw new Error('url 不合法');
      }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        throw new Error('只支持 http/https');
      }
      // 和网页端共用同一道防线：别让一个「下载」按钮变成读内网的口子
      await assertPublicHost(target.hostname);

      // 注意顺序：sanitizeFilename('') 返回的是 'download' 而不是空串，
      // 所以不能写成 `sanitizeFilename(a.filename || '') || basename`——那样永远拿到 'download'
      const fromUrl = decodeURIComponent(path.basename(target.pathname || '')) || '';
      const guessed = sanitizeFilename(String(a.filename || '').trim() || fromUrl || 'download');
      const job = downloadQueue.add({
        url: raw,
        name: guessed,
        title: String(a.title || '').slice(0, 80),
        platform: String(a.platform || ''),
      });

      return (
        `已加入下载队列\n` +
        `job_id: ${job.id}\n` +
        `文件: ${job.file}\n` +
        `目录: ${DOWNLOAD_DIR}\n` +
        `下一步：download_status(job_id="${job.id}") 查进度；下完的文件会出现在上面这个目录里。`
      );
    },
  },

  {
    name: 'download_status',
    description: '查下载队列的进度：已下载多少、总大小、速度、分了几段、有没有报错。不传 job_id 就返回全部任务。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'download_package 返回的 id；不传则列出所有任务' },
      },
    },
    handler: async (a) => {
      const id = String(a.job_id || '').trim();
      const all = downloadQueue.list();
      const picked = id ? all.filter((j) => j.id === id) : all.slice(0, 10);

      if (!picked.length) {
        return id
          ? `队列里没有 ${id}。可能已经被移除，或者服务重启过（队列是内存态，重启会清空，但文件仍在 ${DOWNLOAD_DIR}）。`
          : '队列是空的。';
      }

      const label = { downloading: '下载中', queued: '排队中', done: '已完成', error: '失败', canceled: '已取消' };
      const lines = picked.map((j) => {
        const bits = [`${label[j.status] || j.status} ${j.sizeText}${j.totalText ? ` / ${j.totalText}` : ''}`];
        if (j.percent) bits.push(`${j.percent}%`);
        if (j.speedText) bits.push(j.speedText);
        if (j.parallel > 1) bits.push(`${j.parallel} 段`);
        if (j.error) bits.push(`错误：${j.error}`);
        // 告诉模型下一步能干什么，否则它面对一条红字只会重新搜一遍
        if (j.canRetry) bits.push(`可重试（retry_download job_id="${j.id}"）`);
        return `· ${j.title || j.name}（${j.id}）\n  ${bits.join(' · ')}${j.file ? `\n  文件：${j.file}` : ''}`;
      });
      return lines.join('\n');
    },
  },

  {
    name: 'retry_download',
    description:
      '重试一条失败或已取消的下载。直链任务复用同一个 id 与 .part，从断点续传（已下的部分不重下）；' +
      'Play / Apple 的任务按发起时记下的参数重新跑一遍。job_id 从 download_status 里拿。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '要重试的任务 id' },
      },
      required: ['job_id'],
    },
    handler: async (a) => {
      const id = String(a.job_id || '').trim();
      if (!id) throw new Error('job_id 不能为空');
      const out = retryJob(id);
      if (out.error) throw new Error(out.error);
      const what =
        out.kind === 'download' ? '已重新排队，会从 .part 的断点继续' : `已重新发起（${out.kind}）`;
      return `${what}\njob_id: ${id}\n下一步：download_status(job_id="${id}") 看进度。`;
    },
  },

  {
    name: 'list_devices',
    description: '列出通过 USB 连着的 Android（adb）和 iOS（pymobiledevice3）设备，以及本机有没有装这些工具。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const out = await devices.detect(false);
      const list = out.devices || [];
      const tools = out.tools || {};
      const head =
        `adb: ${tools.adb?.available ? '有' : '没有'} · ` +
        `pymobiledevice3: ${tools.pymobiledevice3?.available ? '有' : '没有'}`;
      if (!list.length) {
        return `${head}\n没有检测到已连接的设备。Android 要开 USB 调试并授权这台电脑。`;
      }
      const lines = list.map(
        (d) =>
          `· ${d.name}（${d.platform}）${d.ready ? '' : ` — ${d.state}`}\n  id: ${d.id}${d.detail ? `\n  ${d.detail}` : ''}`
      );
      return [head, ...lines].join('\n');
    },
  },

  {
    name: 'install_package',
    description:
      '把 .downloads 里已经下好的安装包装到设备上（Android 用 adb install-multiple，iOS 用 pymobiledevice3）。' +
      '文件必须已经在这个目录里，先用 download_package + download_status 拿到。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.downloads 里的文件名，例如 com.tencent.mm_2580.apk' },
        device: { type: 'string', description: 'list_devices 返回的设备 id' },
        platform: { type: 'string', enum: ['android', 'ios'], description: '设备平台' },
      },
      required: ['file', 'device', 'platform'],
    },
    handler: async (a) => {
      const file = path.basename(String(a.file || ''));
      const device = String(a.device || '').trim();
      const platform = String(a.platform || '').trim();
      if (!file || !device) throw new Error('file 和 device 都必须给');
      if (!['android', 'ios'].includes(platform)) throw new Error('platform 只能是 android 或 ios');
      if (!devices.safeFile(DOWNLOAD_DIR, file)) throw new Error('文件名不合法');

      const job = downloadQueue.add({
        file,
        name: file,
        platform,
        kind: 'install',
        install: { platform, device, name: String(a.device || '').slice(0, 80) },
      });
      return `已排入安装队列\njob_id: ${job.id}\n文件: ${file} → ${device}\n用 download_status(job_id="${job.id}") 看结果。`;
    },
  },
];

const mcpServer = createMcp({
  name: 'anypkg',
  version: '1.0.0',
  instructions:
    'AnyPkg 是一个本地跑的全平台安装包检索与下载工具，聚合 App Store（含全区）、Google Play、' +
    '应用宝、Aptoide、F-Droid、APKPure、Homebrew Cask、Winget、Snapcraft、Flathub 等十余个商店。\n' +
    '典型用法：search_apps 找到应用 → 拿到直链 → download_package 入队 → download_status 看进度 → ' +
    '需要的话 install_package 装到手机。\n' +
    '注意：搜不到时先换叫法（中文名 / 英文名 / 包名）再试；Play 渠道对部分应用拿不到下载链接，' +
    '这时结果里通常还有 APKPure / 应用宝 / Aptoide 的直链可用。下载失败或取消的任务可以用 ' +
    'retry_download 重试（直链会从断点续，不会白下一遍）。下载的文件都落在本机 .downloads 目录。',
  tools: MCP_TOOLS,
});

/**
 * 启动时把 .downloads 里已有的包重新登记进队列。
 *
 * 队列本身是内存态，重启就空。但文件还在磁盘上——不重建清单的话，
 * 用户重启一次就看不到自己下过什么了，只能去 Finder 里翻。
 * 按修改时间倒序，只认安装包后缀，.part 这种半截文件跳过。
 */
async function restoreQueueFromDisk() {
  const KEEP = /\.(ipa|apk|xapk|apks|pkg|dmg|exe|msi|deb|rpm|snap|flatpakref|appimage)$/i;
  try {
    const names = await fsp.readdir(DOWNLOAD_DIR);
    const files = [];
    for (const name of names) {
      if (!KEEP.test(name)) continue;
      const full = path.join(DOWNLOAD_DIR, name);
      try {
        const st = await fsp.stat(full);
        if (st.isFile() && st.size > 0) files.push({ name, size: st.size, at: st.mtimeMs });
      } catch {
        /* 读不到就跳过，不影响启动 */
      }
    }
    files.sort((a, b) => b.at - a.at);
    const platformOf = (n) => (/\.(ipa|pkg)$/i.test(n) ? 'ios' : /\.apk$/i.test(n) ? 'android' : '');
    for (const f of files) {
      const job = downloadQueue.adopt({
        name: f.name,
        file: f.name,
        platform: platformOf(f.name),
        size: f.size,
      });
      // adopt 用「现在」当完成时间，这里改回真实修改时间，列表顺序才不会被重启打乱
      if (job) {
        const raw = downloadQueue.jobs.find((j) => j.id === job.id);
        if (raw) raw.finishedAt = f.at;
      }
    }
    if (files.length) console.log(`下载目录里已有 ${files.length} 个包，已挂回队列`);
  } catch {
    /* 目录还没建，第一次启动的正常情况 */
  }
}

// apkeep 的默认源用 F-Droid：免登录、有签名校验。APKPure 覆盖面更大，但 EFF 记录过它
// 分发被篡改的应用（USAGE-apkpure.md），要用必须自己设 APK_SOURCE=apk-pure 显式开启。
const APK_SOURCE = process.env.APK_SOURCE === 'apk-pure' ? 'apk-pure' : 'f-droid';

const LOCAL_TOOLS = {
  apkeep: {
    bin: 'apkeep',
    platforms: ['android'],
    install: 'brew install apkeep',
    note:
      APK_SOURCE === 'apk-pure'
        ? 'APKPure 源（已显式开启，注意该源曾被发现分发被篡改的应用）'
        : 'F-Droid 源，只收录开源应用，下载后校验维护者签名',
    sourceLabel: APK_SOURCE === 'apk-pure' ? 'APKPure' : 'F-Droid',
    buildArgs: (id) =>
      APK_SOURCE === 'apk-pure'
        ? ['-a', id, '-d', 'apk-pure', '-o', 'acknowledge_dangers=true', '.']
        : ['-a', id, '-d', 'f-droid', '.'],
  },
  // Google Play 官方包：走 gplaydl（纯 Python，无需 Java），用用户自己的 Google 账号。
  // 很多应用在 Play 上是 App Bundle，会下到 base.apk + 若干 split，故多文件时打包成 zip。
  gplaydl: {
    bin: 'gplaydl',
    bins: [
      process.env.GPLAYDL_BIN,
      'gplaydl',
      path.join(os.homedir(), '.workbuddy-ai/binaries/python/envs/default/bin/gplaydl'),
    ].filter(Boolean),
    platforms: ['android'],
    install: 'pip install gplaydl',
    note: 'Google Play 官方包（含 split / OBB），需要你自己的 Google 账号，手机装 Authenticator 配对一次',
    sourceLabel: 'Google Play',
    needsLink: true,
    linkHint: '先在终端运行 gplaydl link，按提示用手机上的 Authenticator 配对',
    buildArgs: (id) => ['download', id, '-o', '.', '--no-extras'],
  },
  ipatool: {
    bin: 'ipatool',
    // 不再走通用 CLI 下载通道：IPA 要能选设备、选历史版本、看进度，
    // 这些都得走 /api/apple/*，见 lib/apple.js。这里留着只是为了在面板里显示安装状态。
    platforms: ['ios', 'macos'],
    install: 'brew install ipatool',
    note: '用你自己的 Apple ID 从 App Store 取 .ipa / .pkg，只能下免费或已购应用',
    sourceLabel: 'App Store',
    uiOnly: true,
  },
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,119}$/;

function runTool(bin, args, { cwd, timeout = 300000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ''}` },
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          message: err ? String(err.message || err) : '',
        });
      }
    );
  });
}

let backendCache = null;
let backendAt = 0;

async function detectBackends(force = false) {
  if (!force && backendCache && Date.now() - backendAt < 30000) return backendCache;

  const tools = {};
  for (const [key, def] of Object.entries(LOCAL_TOOLS)) {
    let binPath = '';
    for (const cand of def.bins || [def.bin]) {
      if (cand.includes('/')) {
        if (fs.existsSync(cand)) {
          binPath = cand;
          break;
        }
        continue;
      }
      const probe = await runTool('which', [cand], { timeout: 5000 });
      if (probe.code === 0) {
        binPath = probe.stdout.trim().split('\n')[0];
        break;
      }
    }
    tools[key] = {
      key,
      label: def.bin,
      available: Boolean(binPath),
      path: binPath,
      install: def.install,
      note: def.note,
      sourceLabel: def.sourceLabel || '',
      platforms: def.platforms,
      authed: null,
    };
  }

  // ipatool 的登录态必须走 apple.status()：它会给子进程注入代理环境，而 auth info
  // 本身要联网；用裸 execFile 直连拿不到响应，会把「已登录」误判成未登录。
  if (tools.ipatool.available) {
    const st = await apple.status();
    tools.ipatool.authed = st.authed;
    tools.ipatool.email = st.email || '';
    tools.ipatool.name = st.name || '';
  } else {
    tools.ipatool.authed = false;
  }

  // gplaydl 必须先和手机上的 Authenticator 配对过（或提供 GPLAYDL_API_KEY）
  if (tools.gplaydl?.available) {
    const cfg = path.join(os.homedir(), '.config/gplaydl/config.json');
    tools.gplaydl.authed = Boolean(process.env.GPLAYDL_API_KEY) || fs.existsSync(cfg);
  }

  backendCache = { tools, downloadDir: DOWNLOAD_DIR };
  backendAt = Date.now();
  return backendCache;
}

async function runLocalDownload(toolKey, id) {
  const def = LOCAL_TOOLS[toolKey];
  if (!def) return { ok: false, message: `未知工具 ${toolKey}` };
  if (def.uiOnly) return { ok: false, message: '这个工具要按平台/版本下载，请从卡片上的下载按钮进入' };
  if (!SAFE_ID.test(id)) return { ok: false, message: '应用标识不合法' };

  const be = await detectBackends();
  const tool = be.tools[toolKey];
  if (!tool?.available) {
    return { ok: false, message: `本机没有 ${def.bin}，先运行：${def.install}` };
  }
  if (def.needsLink && !tool.authed) {
    return { ok: false, message: def.linkHint || '这个工具还没完成配对', needsAuth: true };
  }

  try {
    downloadQueue.assertCapacity();
  } catch (err) {
    return { ok: false, message: err.message, code: err.code };
  }

  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  const before = new Set(await fsp.readdir(DOWNLOAD_DIR));

  const r = await runTool(tool.path, def.buildArgs(id), { cwd: DOWNLOAD_DIR, timeout: 600000 });

  const after = await fsp.readdir(DOWNLOAD_DIR);
  const fresh = after.filter((f) => !before.has(f) && !f.startsWith('.'));

  const files = [];
  for (const name of fresh) {
    try {
      const st = await fsp.stat(path.join(DOWNLOAD_DIR, name));
      files.push({ name, size: st.size, sizeText: fmtSize(st.size) });
    } catch {
      /* 忽略 */
    }
  }

  // Play 上很多应用是 App Bundle：会下到 base.apk + 若干 split，逐个点下载没意义。
  // 打包成一个 zip，附带安装说明，用户 `adb install-multiple` 即可。
  let zipped = null;
  if (files.length > 1) {
    const zipName = `${id}.zip`;
    const zipPath = path.join(DOWNLOAD_DIR, zipName);
    try {
      await fsp.rm(zipPath, { force: true });
      const z = await runTool('zip', ['-j', '-q', zipName, ...files.map((f) => f.name)], {
        cwd: DOWNLOAD_DIR,
        timeout: 120000,
      });
      if (z.code === 0) {
        const st = await fsp.stat(zipPath);
        for (const f of files) await fsp.rm(path.join(DOWNLOAD_DIR, f.name), { force: true });
        files.length = 0;
        files.push({ name: zipName, size: st.size, sizeText: fmtSize(st.size), bundle: true });
        zipped = zipName;
      }
    } catch {
      /* 打包失败就退回逐个文件 */
    }
  }

  const log = `${r.stdout}\n${r.stderr}`.trim();
  const hint =
    toolKey === 'apkeep' && APK_SOURCE === 'f-droid'
      ? 'F-Droid 只收录开源应用，这个包不在里面。可以试卡片上 Aptoide 那个按钮。'
      : '';

  return {
    ok: r.code === 0 && files.length > 0,
    files,
    log: log.slice(-900),
    message: files.length
      ? zipped
        ? `已打包 ${zipped}（base + split），手机连电脑后执行 adb install-multiple 解压出的 *.apk`
        : ''
      : hint || r.message || log.slice(-300) || '没有产出文件',
  };
}

/* ------------------------------------------------------------------ */
/* 下载代理（放行公网地址，挡住回环 / 内网，避免被当成任意 URL 转发器） */
/* ------------------------------------------------------------------ */

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal']);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  if (v.startsWith('fe80')) return true;
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return false;
}

async function assertPublicHost(hostname) {
  if (BLOCKED_HOSTS.has(hostname)) throw new Error('host blocked');
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('private address blocked');
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error('dns lookup failed');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('private address blocked');
  }
}

async function assertPublicUrl(raw) {
  const target = raw instanceof URL ? raw : new URL(String(raw));
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error('only http(s) allowed');
  }
  await assertPublicHost(target.hostname);
}

function hasExtension(name) {
  return /\.[a-z0-9]{2,5}$/i.test(name);
}

async function handleDownload(req, res, params) {
  const raw = params.get('u');
  if (!raw) return sendJson(res, 400, { error: 'missing u' });

  let target;
  try {
    target = new URL(raw);
  } catch {
    return sendJson(res, 400, { error: 'invalid url' });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return sendJson(res, 400, { error: 'only http(s) allowed' });
  }
  try {
    await assertPublicUrl(target);
  } catch (e) {
    return sendJson(res, 403, { error: String(e.message || e) });
  }

  let name;
  try {
    name = sanitizeFilename(params.get('n') || decodeURIComponent(path.basename(target.pathname)));
  } catch {
    name = sanitizeFilename(params.get('n') || 'download');
  }

  // 下载统一走 node 流：连接阶段 8s 快速失败，拿到响应后换成 120s 空闲超时，
  // 这样几百 MB 的包不会因为"总时长"被掐断。国内 CDN 优先直连，走不通再回退代理。
  //
  // 透传 Range：几百 MB 的包断一次就从 0 重来太亏。浏览器自己会带 Range 重试，
  // 只要上游支持、我们也如实回 206 + Content-Range，续传就成立。
  const range = req.headers.range;
  let upstream;
  try {
    upstream = await smartOpen(target.toString(), {
      headers: {
        'user-agent': UA,
        accept: '*/*',
        'accept-encoding': 'identity',
        ...(range ? { range } : {}),
      },
      timeout: 8000,
      idleTimeout: 120000,
      prefer: 'direct',
      hardPrefer: true,
      validateUrl: assertPublicUrl,
    });
  } catch (e) {
    return sendJson(res, 502, { error: String(e.message || e) });
  }

  if (upstream.status < 200 || upstream.status >= 300) {
    upstream.stream.resume();
    return sendJson(res, 502, { error: `upstream ${upstream.status}` });
  }

  // 自己猜的文件名没有扩展名时（比如 VS Code 的 /stable 重定向），用上游给的名字
  if (!hasExtension(name)) {
    const cd = upstream.headers['content-disposition'] || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    if (m) {
      try {
        const guess = sanitizeFilename(decodeURIComponent(m[1]));
        if (hasExtension(guess)) name = guess;
      } catch {
        /* 用回原来的名字 */
      }
    }
  }

  const headers = {
    'content-type': upstream.headers['content-type'] || 'application/octet-stream',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };
  const len = upstream.headers['content-length'];
  if (len) headers['content-length'] = len;
  // 上游真的按 Range 切了才回 206，否则老实回 200——谎报会让前端拼出坏文件
  if (upstream.status === 206 && upstream.headers['content-range']) {
    headers['content-range'] = upstream.headers['content-range'];
  }

  res.writeHead(upstream.status === 206 && headers['content-range'] ? 206 : 200, headers);

  upstream.stream.once('error', () => {
    try {
      res.destroy();
    } catch {}
  });
  const abort = () => {
    try {
      upstream.stream.destroy();
    } catch {}
  };
  req.on('close', abort);
  res.on('close', abort);

  upstream.stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'referrer-policy': 'no-referrer',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * 把 Play 服务的 SSE 原样转给浏览器。断连时必须掐掉上游，
 * 否则一次误关页面会让服务端继续合并一个几百兆的包。
 */
function pipeSse(req, res, upstream) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true;
    try {
      upstream.abort();
    } catch {
      /* 上游可能已经结束 */
    }
  };
  req.on('close', stop);
  res.on('close', stop);
  upstream.stream.on('data', (c) => {
    if (!res.write(c)) upstream.stream.pause();
  });
  res.on('drain', () => upstream.stream.resume());
  upstream.stream.on('end', () => {
    closed = true;
    res.end();
  });
  upstream.stream.on('error', () => {
    closed = true;
    res.end();
  });
}

/**
 * 把一次 Apple / Play 传输记进下载队列。
 *
 * 这两条链路都在各自的 SSE 请求里跑，队列调度不了、也压不住它们的并发；
 * 但它们动辄几分钟，用户不可能一直守着一个弹窗。所以这里只做「记账」：
 * 进度由上层喂进来，队列负责让它在面板上实时可见，关掉弹窗也还在。
 */
function trackTransfer({
  name,
  title = '',
  platform,
  kind = 'app',
  total = 0,
  onCancel = null,
  retry = null,
  resumeId = '',
}) {
  // 自己存一份取消标记：任务被 drop 掉之后队列里就找不到它了，
  // 但传输仍在排队等着，得靠这个标记在轮到时直接放弃
  let canceled = false;
  let waiting = false;
  const cancelHook = () => {
    canceled = true;
    // 排队中的任务手上没有在跑的进程，这时候回调 onCancel 会把
    // 排在它前面、正在下载的那一个杀掉
    if (waiting) return;
    try {
      onCancel?.();
    } catch {
      /* 发起方已经收手 */
    }
  };
  // 重试时传 resumeId：复用失败的那条记录，面板上不会多出一条重复的
  const id =
    (resumeId && downloadQueue.reopen(resumeId, { onCancel: cancelHook }) && resumeId) ||
    downloadQueue.begin({ name, title, platform, kind, total, onCancel: cancelHook, retry });
  return {
    id,
    get canceled() {
      return canceled;
    },
    get waiting() {
      return waiting;
    },
    event(evt) {
      if (!evt) return;
      // 排队位置是 Apple 侧给的：轮到它了自己会发 start，这时把标记摘掉
      if (evt.queued) {
        waiting = true;
        downloadQueue.markWaiting(id, true);
      } else if (evt.type === 'start' || (evt.type === 'progress' && evt.bytes)) {
        waiting = false;
        downloadQueue.markWaiting(id, false);
      }
      if (evt.type === 'start') downloadQueue.progress(id, 0, evt.total);
      else if (evt.type === 'progress' && evt.bytes) downloadQueue.progress(id, evt.bytes, evt.total);
    },
    progress(bytes, total) {
      downloadQueue.progress(id, bytes, total);
    },
    done(file, size) {
      downloadQueue.finishExternal(id, { file, size });
    },
    fail(message, code = '') {
      downloadQueue.failExternal(id, message, code);
    },
  };
}

/**
 * 转发上游 SSE，顺便在每条事件上挂个回调。
 *
 * pipeSse 是纯透传，拿不到事件内容；Play 的 prepare 需要在 success 之后
 * 把临时文件落盘，所以这里多一个 tap。事件量很小（只有进度文字），
 * 不处理背压也不会撑爆内存。
 *
 * onAbort 只在「客户端提前断开」时触发，正常结束不调——否则队列里的任务
 * 会被自己刚完成的收尾动作误标成失败。
 */
/**
 * 解析一条 SSE 上游流，逐条回调。
 *
 * Play 的事件有两个消费者：网页端要透传下去，队列重试时没有人接、只喂给队列。
 * 解析规则一样（data: {...} 空行分隔，非 JSON 的行是心跳），抽出来别抄两遍。
 */
function tapSseStream(stream, onEvent, onEnd) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line.slice(6));
      } catch {
        continue; // 上游偶尔有非 JSON 的心跳
      }
      try {
        onEvent?.(evt);
      } catch {
        /* 副作用失败不该把流带崩 */
      }
    }
  });

  let fired = false;
  const done = () => {
    if (fired) return;
    fired = true;
    try {
      onEnd?.();
    } catch {
      /* 收尾失败不该盖住断线本身 */
    }
  };
  stream.on('end', done);
  stream.on('error', done);
  // 上游被强杀（Python 进程没了、代理整条断掉）时可能只发 close，没有 end/error。
  // 不监听它，队列里那条任务会永远停在「下载中」——进度不动，也不给重试按钮
  stream.on('close', done);
}

function pipeSseTap(req, res, upstream, onEvent, onAbort, { abortOnClose = true } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  tapSseStream(
    upstream.stream,
    (evt) => {
      // 客户端已经走了还写会抛 ERR_STREAM_WRITE_AFTER_END；此时传输仍在继续，
      // 只是没人接事件了（进度照样记在队列里）
      if (!res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
      try {
        onEvent?.(evt);
      } catch {
        /* 副作用失败不该把流带崩 */
      }
    },
    () => {
      try {
        res.end();
      } catch {
        /* 已经断了 */
      }
    }
  );

  // 只能用 res 的 close 判断客户端断开：req 的 close 在请求体读完时就触发
  // （Node 16 起的行为），GET 请求会立刻命中，等于刚连上就把上游 abort 了
  res.on('close', () => {
    if (res.writableEnded) return;
    try {
      onAbort?.();
    } catch {
      /* 收尾失败不该盖住断线本身 */
    }
    // 关标签/刷新页面时默认让上游继续跑完：反正结果会落盘进队列，
    // 用户回来还能在列表里拿到，「关掉也能继续下」才不是一句空话
    if (!abortOnClose) return;
    try {
      upstream.abort();
    } catch {
      /* 忽略 */
    }
  });
}

/**
 * 把 Play 合并好的 APK 落到 .downloads 并登记进队列。
 *
 * 原来它只活在 Python 侧的临时目录里，取一次就删——用户晚几分钟再点就 404，
 * 而且没法「下几个一起取」。落盘之后和普通下载完全一样：列表里能保存、能装、能定位。
 *
 * tracking 传进来时说明队列里已经有一条这个任务的实时进度，直接把它收尾就行，
 * 不要再 adopt 出一条重复的。
 */
async function adoptPlayApk(id, filename, tracking = null) {
  const name = sanitizeFilename(filename || `${id}.apk`);
  const dest = path.join(DOWNLOAD_DIR, name);
  try {
    const up = await gplay.openStream(`/api/download-temp/${id}`, { timeout: 20000 });
    if (up.status !== 200) {
      up.stream.resume();
      tracking?.fail(`落盘失败（Play 服务返回 ${up.status}）`);
      return null;
    }
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      up.stream.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      up.stream.on('error', reject);
    });
    const st = await fsp.stat(dest);
    if (tracking) tracking.done(name, st.size);
    else downloadQueue.adopt({ name, file: name, platform: 'android', size: st.size });
    return name;
  } catch {
    // 落盘失败不致命：前端还留着 download_id，仍能直接取一次
    tracking?.fail('合并包落盘失败');
    return null;
  }
}

/**
 * 队列面板上点「重试」时，服务端自己把 Play 的下载重跑一遍。
 *
 * 和 /api/play/prepare 的差别只有一个：那边事件写进一个 HTTP 响应，这边没人接，
 * 事件直接喂给队列。所以逻辑必须和那边保持一致——成功后同样是「先落盘、再收尾」，
 * 失败也要带错误码，面板才能判断这条还值不值得再给一次重试。
 */
async function runPlayTransfer({ pkg, arch = 'arm64-v8a', title = '', jobId = '' }) {
  let up = null;
  const tracking = trackTransfer({
    name: `${pkg}.apk`,
    title,
    platform: 'android',
    resumeId: jobId,
    retry: { kind: 'play', pkg, arch, title },
    onCancel: () => up?.abort(),
  });

  try {
    if (!(await gplay.ensure())) {
      tracking.fail('Play 服务没起来，检查 gplay-server/server.log');
      return;
    }
    up = await gplay.openStream(
      `/api/download-merged-stream/${encodeURIComponent(pkg)}?arch=${arch}`,
      { timeout: 600000 }
    );
    if (up.status !== 200) {
      up.stream.resume();
      tracking.fail(`Play 服务返回 ${up.status}`);
      return;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      tapSseStream(
        up.stream,
        (evt) => {
          if (evt.type === 'progress') {
            tracking.progress(evt.bytes, evt.bytesTotal);
          } else if (evt.type === 'error') {
            settled = true;
            tracking.fail(evt.message, evt.code);
            resolve();
          } else if (evt.type === 'success' && evt.download_id) {
            settled = true;
            adoptPlayApk(evt.download_id, evt.filename, tracking)
              .catch(() => tracking.fail('合并包落盘失败'))
              .finally(resolve);
          }
        },
        () => {
          // 上游正常结束但没发 success：不是「下完了」，得说清楚
          if (!settled) {
            tracking.fail('Play 的连接提前结束了，没拿到合并包');
            finish();
          }
        }
      );
    });
  } catch (e) {
    tracking.fail(String(e.message || e));
  }
}

/**
 * Apple（ipatool）的重试。ipatool 一次只跑一个，队列里那条复用同一个 id，
 * 所以用户点重试之后看到的是原来那条从 0 开始走，而不是多出一条新记录。
 */
async function runAppleTransfer({ bundle, plat = 'iphone', versionId = '', title = '', jobId = '' }) {
  const tracking = trackTransfer({
    name: `${bundle}.ipa`,
    title,
    platform: plat === 'iphone' || plat === 'ipad' ? 'ios' : 'mac',
    resumeId: jobId,
    retry: { kind: 'apple', bundle, plat, versionId, title },
    onCancel: () => apple.cancelCurrent(),
  });

  try {
    const out = await apple.download({
      bundleId: bundle,
      platform: plat,
      versionId,
      dir: DOWNLOAD_DIR,
      onEvent: (evt) => tracking.event(evt),
      shouldAbort: () => tracking.canceled,
    });
    if (out.ok) tracking.done(out.file, out.size || 0);
    else tracking.fail(out.canceled ? '已取消' : out.message, out.code);
  } catch (e) {
    tracking.fail(String(e.message || e));
  }
}

/**
 * 重试一条任务（网页按钮和 MCP 共用一个入口）。
 *
 * 三类任务的「重试」不是同一件事：
 *  - 直链下载：回到排队态，fetchOnce 会从 .part 的断点接着下；
 *  - Play / Apple：队列调度不了它们，只能按发起时记下的参数再叫一遍；
 *  - 纯安装任务：没有可重来的下载，安装失败请回去重点一次「装到设备」。
 */
function retryJob(id) {
  const job = downloadQueue.raw(id);
  if (!job) return { error: '任务不存在' };
  if (job.status !== 'error' && job.status !== 'canceled') {
    return { error: '只有失败或已取消的任务可以重试' };
  }
  if (!retryable(job)) {
    // 面板上本来就不给按钮，接口也挡一下：这种错误再点几次都是同一句话
    return { error: '这个错误重试也是同样的结果（应用不在你账号的商店区，或需要先付费/获取），换个来源更实际' };
  }

  if (job.external) {
    try {
      downloadQueue.assertCapacity();
    } catch (err) {
      return { error: err.message, code: err.code };
    }
    const r = job.retry;
    if (!r || !r.kind) {
      return { error: '这条任务没有记录重启所需的信息（服务重启前发起的老任务重试不了，回列表重新点一次）' };
    }
    if (r.kind === 'play') {
      runPlayTransfer({ ...r, jobId: id });
      return { ok: true, kind: 'play' };
    }
    if (r.kind === 'apple') {
      runAppleTransfer({ ...r, jobId: id });
      return { ok: true, kind: 'apple' };
    }
    return { error: `不支持重试的类型：${r.kind}` };
  }

  const out = downloadQueue.retry(id);
  return out.error ? out : { ok: true, kind: 'download', job: out.job };
}

/** Play 合并好的 APK 只在临时目录活一小会儿，取一次就删，所以这里直连直转 */
async function handlePlayFile(req, res, params) {
  const id = String(params.get('id') || '').trim();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) return sendJson(res, 400, { error: 'bad id' });

  const name = sanitizeFilename(params.get('n') || 'app.apk');
  // 已经落盘过就直接发本地那份：临时文件是一次性的，取走就没了，
  // 但用户可能过一会儿又点一次「保存」
  const local = path.join(DOWNLOAD_DIR, name);
  if (fs.existsSync(local)) {
    res.writeHead(302, { location: `/api/file?name=${encodeURIComponent(name)}` });
    return res.end();
  }
  let up;
  try {
    up = await gplay.openStream(`/api/download-temp/${id}`, { timeout: 20000 });
  } catch (e) {
    return sendJson(res, 502, { error: String(e.message || e) });
  }
  if (up.status !== 200) {
    up.stream.resume();
    return sendJson(res, 404, { error: '文件已过期，请重新下载' });
  }

  const headers = {
    'content-type': 'application/vnd.android.package-archive',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
  };
  if (up.headers['content-length']) headers['content-length'] = up.headers['content-length'];
  res.writeHead(200, headers);

  const abort = () => {
    try {
      up.stream.destroy();
    } catch {
      /* 忽略 */
    }
  };
  req.on('close', abort);
  res.on('close', abort);
  up.stream.on('error', () => res.destroy());
  up.stream.pipe(res);
}

function serveDownloadFile(req, res, name) {
  const safe = path.basename(String(name || ''));
  if (!safe || safe.startsWith('.')) {
    return sendJson(res, 400, { error: 'bad name' });
  }
  const file = path.join(DOWNLOAD_DIR, safe);
  fs.stat(file, async (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });

    const base = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    };

    // 合并包动辄 180MB，浏览器中途断线是常事；不给 Range 就只能从 0 重下。
    // 只认单段（`bytes=a-b` / `bytes=a-` / `bytes=-N`）——这是浏览器和 curl 续传的形态，
    // 多段（`bytes=a-b,c-d`）纯属小众优化，成本远大于收益，忽略掉当整包发更安全。
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    let start = 0;
    let end = st.size - 1;
    let partial = false;
    if (m && (m[1] || m[2]) && st.size > 0) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
      } else {
        // `bytes=-N` 取最后 N 字节
        start = Math.max(0, st.size - Number(m[2]));
      }
      // 越界要回 416 并带 `bytes */size`，否则播放器/下载器会以为服务器坏了
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
        res.writeHead(416, { ...base, 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      partial = true;
    }

    res.writeHead(partial ? 206 : 200, partial
      ? { ...base, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}` }
      : { ...base, 'content-length': st.size });

    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(file, partial ? { start, end } : undefined);
    // 客户端点「取消」时 pipe 不会自己关源文件，183MB 的句柄会一直挂着
    res.on('close', () => stream.destroy());
    stream.once('error', () => {
      try {
        res.destroy();
      } catch {}
    });
    stream.pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Apple 通道：SSE 事件直接由本进程产出，不转上游                        */
/* ------------------------------------------------------------------ */

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/;
// Android 包名允许下划线开头（少见但合法），比 bundle id 宽一点
const PACKAGE_ID = /^[A-Za-z0-9_][A-Za-z0-9._]{1,199}$/;

function pickPlatform(v) {
  return apple.PLATFORMS.includes(v) ? v : 'iphone';
}

/** 自己产事件的 SSE 通道；客户端关掉时把 open 置 false，别再往死连接写 */
function sseChannel(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let open = true;
  res.on('close', () => {
    open = false;
  });

  return {
    emit(evt) {
      if (!open) return false;
      try {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      } catch {
        open = false;
      }
      return open;
    },
    close() {
      if (!open) return;
      open = false;
      try {
        res.end();
      } catch {
        /* 已经断了 */
      }
    },
    get open() {
      return open;
    },
  };
}

async function appleVersionsSse(req, res, bundle, platform, limit) {
  const ch = sseChannel(req, res);
  try {
    await apple.versions(bundle, platform, (evt) => ch.emit(evt), { limit });
  } catch (e) {
    ch.emit({ type: 'error', message: String(e.message || e) });
  } finally {
    ch.close();
  }
}

/**
 * 从第三方分发页里抽 IPA 直链（企业签名页 / 自建 OTA 页 / itms-services）。
 *
 * 这里没有任何 Apple 账号参与：页面本身就是公开的，我们只是把
 * `itms-services://...&url=<plist>` 里那个 plist 读出来，拿 assets 里的 .ipa 地址。
 * 所以必须先过一遍 SSRF 检查——用户能填任意 URL，不能让服务去碰内网。
 */
async function appleResolve(pageUrl, { maxManifests = 3 } = {}) {
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return { ok: false, error: '不是合法的 URL' };
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') {
    return { ok: false, error: '只接受 http(s) 链接' };
  }
  await assertPublicHost(page.hostname);

  // 直接粘了个 .ipa 地址就不用抓页面了
  if (/\.ipa$/i.test(page.pathname)) {
    const size = await headSize(page.toString());
    let title = 'ipa';
    try {
      title = decodeURIComponent(path.basename(page.pathname, '.ipa'));
    } catch {
      /* 百分号编码坏了就用兜底名 */
    }
    return {
      ok: true,
      page: page.toString(),
      items: [
        {
          title,
          bundleId: '',
          version: '',
          size,
          sizeText: fmtSize(size),
          ipaUrl: page.toString(),
          via: 'direct',
        },
      ],
    };
  }

  const html = await smartText(page.toString(), {
    timeout: 15000,
    maxBytes: 3 * 1024 * 1024,
    headers: {
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    },
  });

  const { manifests, ipas } = apple.extractTargets(html, page.toString());
  const items = [];
  const seen = new Set();

  for (const ipaUrl of ipas) {
    if (seen.has(ipaUrl)) continue;
    seen.add(ipaUrl);
    items.push({ title: '', bundleId: '', version: '', size: 0, ipaUrl, via: 'link' });
  }

  for (const manifestUrl of manifests.slice(0, maxManifests)) {
    try {
      await assertPublicHost(new URL(manifestUrl).hostname);
      const xml = await smartText(manifestUrl, { timeout: 12000, maxBytes: 512 * 1024 });
      const m = apple.parseManifest(xml);
      if (!m.ipaUrl || seen.has(m.ipaUrl)) continue;
      seen.add(m.ipaUrl);
      items.push({
        title: m.title,
        bundleId: m.bundleId,
        version: m.version,
        size: 0,
        ipaUrl: m.ipaUrl,
        manifestUrl,
        via: 'manifest',
      });
    } catch {
      /* 某个 plist 拿不到不影响其它候选 */
    }
  }

  // 只给前几条补体积：每个都要一次 HEAD，多了反而慢
  await Promise.all(
    items.slice(0, 6).map(async (it) => {
      it.size = await headSize(it.ipaUrl);
      it.sizeText = fmtSize(it.size);
    })
  );

  return {
    ok: true,
    page: page.toString(),
    items: items.slice(0, 8),
    hint: items.length
      ? ''
      : '页面里没找到 itms-services 或 .ipa 链接。有些分发页是前端渲染的，链接要登录后才出现，这种情况得把 plist 或 .ipa 地址直接粘进来。',
  };
}

async function headSize(url) {
  try {
    const res = await smartOpen(url, { method: 'HEAD', timeout: 6000 });
    res.stream.resume();
    if (res.status >= 200 && res.status < 300) return Number(res.headers['content-length']) || 0;
  } catch {
    /* 不给体积不影响下载 */
  }
  return 0;
}

async function appleDownloadSse(req, res, { bundle, plat, versionId, versionIds = [], title = '' }) {
  const ch = sseChannel(req, res);
  ch.emit({ type: 'progress', message: '准备会话…' });

  const queuePlatform = plat === 'iphone' || plat === 'ipad' ? 'ios' : 'mac';
  // 一次下载开一条队列记录；弹窗关掉之后，进度还在面板里走
  const track = (name, retry) => {
    const t = trackTransfer({
      name,
      title,
      platform: queuePlatform,
      retry,
      onCancel: () => apple.cancelCurrent(),
    });
    return { t, onEvent: (evt) => {
      ch.emit(evt);
      t.event(evt);
    } };
  };

  try {
    // 批量：ipatool-py 的 --downloadAllVersion 是同一思路——ipatool 一次只下一个版本，
    // 想留存旧版就得自己串行跑。这里不并发，因为 ipatool 会抢 keychain 和 sinf。
    if (versionIds.length > 1) {
      const files = [];
      const failed = [];

      for (let i = 0; i < versionIds.length; i += 1) {
        // 不再因为「弹窗关了」中断整批：每条都已经记进队列，用户在面板上看得到、
        // 也取消得到。只有他主动取消了这一条，剩下的才不下了
        const vid = versionIds[i];
        ch.emit({
          type: 'batch',
          index: i + 1,
          total: versionIds.length,
          versionId: vid,
          message: `第 ${i + 1}/${versionIds.length} 个版本（${vid}）`,
        });

        const { t, onEvent } = track(`${bundle}（${vid}）`, {
          kind: 'apple',
          bundle,
          plat,
          versionId: vid,
          title,
        });
        const out = await apple.download({
          bundleId: bundle,
          platform: plat,
          versionId: vid,
          dir: DOWNLOAD_DIR,
          onEvent,
          shouldAbort: () => t.canceled,
        });

        if (out.ok) {
          files.push(out.file);
          // 收尾的就是刚开的那条实时任务，不再额外 adopt 一条重复的
          t.done(out.file, out.size || 0);
          ch.emit({ type: 'item-success', versionId: vid, file: out.file, size: out.sizeText });
        } else {
          t.fail(out.canceled ? '已取消' : out.message, out.code);
          // 单个版本失败（常见的：这版没上架 / 没买过）不该中断整批
          failed.push({ versionId: vid, message: out.message });
          ch.emit({ type: 'item-error', versionId: vid, message: out.message, ...out });
          if (out.canceled) break; // 用户取消了，剩下的不再接着跑
        }
      }

      // 一个都没下到就不是 success：前端据此显示红色提示，而不是「全部完成：0 个包」
      if (!files.length) {
        ch.emit({
          type: 'error',
          message: failed[0]?.message || '这些版本都没下下来',
          failed,
        });
        return;
      }

      ch.emit({
        type: 'success',
        files,
        file: files[0],
        size: `${files.length} 个包`,
        failed,
      });
      return;
    }

    const { t, onEvent } = track(`${bundle}.ipa`, { kind: 'apple', bundle, plat, versionId, title });
    const out = await apple.download({
      bundleId: bundle,
      platform: plat,
      versionId,
      dir: DOWNLOAD_DIR,
      onEvent,
      shouldAbort: () => t.canceled,
    });

    if (out.ok) {
      // 收尾的是刚开的那条实时任务，不额外 adopt 一条重复的
      t.done(out.file, out.size || 0);
      ch.emit({ type: 'success', file: out.file, size: out.sizeText, purchased: out.purchased });
    } else {
      t.fail(out.canceled ? '已取消' : out.message, out.code);
      ch.emit({ type: 'error', ...out });
    }
  } catch (e) {
    ch.emit({ type: 'error', message: String(e.message || e) });
  } finally {
    ch.close();
  }
}

/**
 * 「用已登录的 Chrome 换票据」——唯一不需要输密码的登录路径。
 *
 * 为什么绕这么大一圈：
 *  - Chrome 不会把 Google 账号密码存进 Login Data（浏览器自身登录不算表单），
 *    所以「点账号自动填密码」在本机根本没有数据可用；
 *  - iCloud 钥匙串里的 Google 密码，security CLI 没有 entitlement 读不到；
 *  - 把 Chrome 的 cookie 导出来用也没用，DBSC 设备绑定会直接打回登录页（实测）。
 *
 * 剩下唯一活的：让**浏览器自己**去访问 EmbeddedSetup，把一次性 oauth_token
 * 领到这个浏览器上，我们再从 cookie 库读出来换 AAS token。用户已经登录着，
 * 所以那一步通常只是点一下「继续」，不用输密码。
 *
 * 注意：本服务跑在沙箱里时 `open` 会被静默拦掉，所以这个链接必须由用户自己点。
 */
async function playSessionSse(req, res, email) {
  const ch = sseChannel(req, res);
  ch.emit({
    type: 'need-browser',
    url: 'https://accounts.google.com/EmbeddedSetup',
    message: '已登录的 Chrome 还没领过 Play 票据。点上面的链接，在浏览器里点一下「继续」就行，不用输密码。',
  });

  // 用户要在浏览器里选账号、过 ToS，实测 3 分钟很正常，别太早放弃
  let found = null;
  for (let i = 0; i < 200; i += 1) {
    found = await chrome.oauthToken();
    if (found) break;
    if (i && i % 8 === 0) {
      ch.emit({ type: 'progress', message: `还在等浏览器完成授权（${Math.round((i * 1.5) | 0)}s）…` });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!found) {
    ch.emit({
      type: 'error',
      message:
        '等了五分多钟没等到新票据。三种可能：授权页还停在登录界面（那就得输一次密码）、' +
        '你点的是别的浏览器（只能 Chrome / Edge / Brave）、或者这张票上次已经用掉了——' +
        '重新打开 accounts.google.com/EmbeddedSetup 走一遍就有新的。',
      needsTimer: true,
    });
    return ch.close();
  }

  ch.emit({ type: 'progress', message: `从 Chrome（${found.profile}）拿到票据，正在换长期 token…` });
  // 先登记再提交：换成功与否这张票都不能再用第二次
  chrome.markTokenConsumed(found.token);

  if (!(await gplay.ensure())) {
    ch.emit({ type: 'error', message: 'Play 服务没起来，检查 gplay-server/server.log' });
    return ch.close();
  }

  let up;
  try {
    up = await gplay.openStream('/api/auth/google', {
      method: 'POST',
      body: { email: email || found.email || '', oauthToken: found.token },
      timeout: 120000,
    });
  } catch (e) {
    ch.emit({ type: 'error', message: String(e.message || e) });
    return ch.close();
  }
  if (up.status !== 200) {
    up.stream.resume();
    ch.emit({ type: 'error', message: `Play 服务返回 ${up.status}` });
    return ch.close();
  }

  // 上游已经是 SSE，逐条拆开重发；不能整段转发，否则前端分不清事件类型
  let buf = '';
  up.stream.setEncoding('utf8');
  up.stream.on('data', (chunk) => {
    buf += chunk;
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        ch.emit(JSON.parse(line.slice(6)));
      } catch {
        /* 上游偶尔会有非 JSON 的心跳，丢掉 */
      }
    }
  });
  await new Promise((resolve) => {
    up.stream.on('end', resolve);
    up.stream.on('error', resolve);
    req.on('close', resolve);
  });
  ch.close();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (!LOOPBACK_HOSTS.has(BIND_HOST) && req.method !== 'OPTIONS') {
      const queryToken = url.searchParams.get('token') || '';
      const auth = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
      const cookieToken = String(req.headers.cookie || '').match(/(?:^|;\s*)anypkg_token=([^;]+)/)?.[1] || '';
      let parsedCookie = '';
      try {
        parsedCookie = decodeURIComponent(cookieToken);
      } catch {
        parsedCookie = '';
      }
      const candidate = auth || parsedCookie;
      const valid = (value) => {
        const a = Buffer.from(value);
        const b = Buffer.from(REMOTE_TOKEN);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      };

      if (queryToken && valid(queryToken)) {
        url.searchParams.delete('token');
        res.writeHead(303, {
          location: `${url.pathname}${url.search}`,
          'set-cookie': `anypkg_token=${encodeURIComponent(REMOTE_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        return res.end();
      }
      if (!valid(candidate)) return sendJson(res, 401, { error: 'unauthorized' });
    }

    // MCP 协议端点：别的 AI 客户端（Claude Desktop / Cursor / Cherry Studio）从这里接，
    // 和网页共用同一个进程和同一份队列，不另起服务
    if (url.pathname === '/mcp') {
      return mcpServer.handle(req, res);
    }

    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 400, { error: 'empty query' });
      if (q.length > 60) return sendJson(res, 400, { error: 'query too long' });
      // 未知区直接退回中国区，别让一个手改的 URL 把 Apple 两栏全打成 400
      const raw = String(url.searchParams.get('store') || '').toLowerCase();
      const store = raw === ALL_STORES || APPLE_STORES[raw] ? raw : DEFAULT_STORE;
      const t0 = Date.now();
      // fresh=1 是「重试」：上一次某些源超时了，用户不该被那份坏结果锁 45 秒
      const payload = await searchCached(q, {
        fresh: url.searchParams.get('fresh') === '1',
        store,
      });
      return sendJson(res, 200, { ...payload, tookMs: Date.now() - t0 });
    }

    if (url.pathname === '/api/download') {
      return handleDownload(req, res, url.searchParams);
    }

    /* ---------------- Google Play 旁路（登录 / 搜索状态 / 下载） ---------------- */

    if (url.pathname === '/api/play/status') {
      return sendJson(res, 200, await gplay.status());
    }

    if (url.pathname === '/api/play/start' && req.method === 'POST') {
      const ok = await gplay.ensure();
      return sendJson(res, ok ? 200 : 503, ok ? await gplay.status() : { up: false, error: '启动失败，看 gplay-server/server.log' });
    }

    // 本机浏览器里已经登录的 Google 账号：开窗之前就能看见，不用先猜该用哪个号
    if (url.pathname === '/api/play/browsers') {
      return sendJson(res, 200, { browsers: await chrome.accounts() });
    }

    // 手输一次的密码存进钥匙串：下次点账号就能自动取，且每次取都会走系统授权
    if (url.pathname === '/api/play/save-password' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      if (!email || !password) return sendJson(res, 400, { error: '缺邮箱或密码' });
      return sendJson(res, 200, await chrome.savePassword(email, password));
    }

    if (url.pathname === '/api/play/login' && req.method === 'POST') {
      const body = await readJsonBody(req);

      // 点了「用这个账号」但没带密码：服务端自己找一次，别为这个再开一个浏览器窗口。
      // 顺序是浏览器密码库（静默）→ 钥匙串（会弹系统授权）。
      if (body.email && body.preferPassword && !body.password) {
        const email = String(body.email);
        const hit = await chrome.passwordFor(email, { browserId: body.browser || 'chrome' });
        if (hit) {
          body.password = hit.password;
          body.passwordFrom = `浏览器密码库（${hit.profile}）`;
        } else {
          const kc = await chrome.keychainPassword(email);
          if (kc) {
            body.password = kc;
            body.passwordFrom = '钥匙串';
          }
        }
        if (!body.password) {
          // 412 而不是 200：前端据此弹「换一条路登录」，而不是当成登录失败。
          // 这里必须说清原因——Chrome 压根不把 Google 账号密码存进 Login Data
          // （浏览器自身的登录不是网页表单），所以「找不到」是常态，不是坏了。
          return sendJson(res, 412, {
            needsPassword: true,
            email,
            error:
              '本机没有这个账号的密码：Chrome 密码库里没有 google.com 的记录' +
              '（Chrome 不保存浏览器自身的登录密码），钥匙串里也没有对应条目。',
          });
        }
      }

      if (!(await gplay.ensure())) {
        return sendJson(res, 503, { error: 'Play 服务没起来，检查 gplay-server/server.log' });
      }
      let up;
      try {
        // loginHint 由 Python 侧拼到登录页 URL 上，只是个预填提示
        up = await gplay.openStream('/api/auth/google', { method: 'POST', body, timeout: 60000 });
      } catch (e) {
        return sendJson(res, 502, { error: String(e.message || e) });
      }
      if (up.status !== 200) {
        up.stream.resume();
        return sendJson(res, 502, { error: `Play 服务返回 ${up.status}` });
      }
      return pipeSse(req, res, up);
    }

    // 免密码登录：借 Chrome 已经登录的会话领一张一次性票据，再换长期 token
    if (url.pathname === '/api/play/session') {
      const email = String(url.searchParams.get('email') || '').trim();
      return playSessionSse(req, res, email);
    }

    if (url.pathname === '/api/play/logout' && req.method === 'POST') {
      return sendJson(res, 200, { ok: await gplay.logout() });
    }

    // 粘 Play 链接直下时，先用它把应用名取出来——队列里显示的才是名字而不是一串包名
    if (url.pathname === '/api/play/info') {
      const pkg = String(url.searchParams.get('pkg') || '').trim();
      if (!/^[A-Za-z0-9._]{2,200}$/.test(pkg)) return sendJson(res, 400, { error: 'bad package' });
      if (!(await gplay.ensure())) return sendJson(res, 503, { error: 'Play 服务没起来' });
      try {
        const r = await gplay.request(`/api/info/${encodeURIComponent(pkg)}`, { timeout: 20000 });
        return sendJson(res, r.status === 200 ? 200 : 404, r.data);
      } catch (e) {
        return sendJson(res, 502, { error: String(e.message || e) });
      }
    }

    if (url.pathname === '/api/play/prepare') {
      const pkg = String(url.searchParams.get('pkg') || '').trim();
      if (!/^[A-Za-z0-9._]{2,200}$/.test(pkg)) return sendJson(res, 400, { error: 'bad package' });
      downloadQueue.assertCapacity();
      const arch = url.searchParams.get('arch') === 'armeabi-v7a' ? 'armeabi-v7a' : 'arm64-v8a';
      if (!(await gplay.ensure())) return sendJson(res, 503, { error: 'Play 服务没起来' });

      let up;
      try {
        up = await gplay.openStream(
          `/api/download-merged-stream/${encodeURIComponent(pkg)}?arch=${arch}`,
          // 这里给的是整条流的空闲超时，不是「总耗时」；但 Node 的
          // http.request.setTimeout 在连接被占满时也会触发，大包（60MB+）
          // 下载加合并经常超过 60 秒，用原来那个值会在中途被直接掐断
          { timeout: 600000 }
        );
      } catch (e) {
        return sendJson(res, 502, { error: String(e.message || e) });
      }
      if (up.status !== 200) {
        up.stream.resume();
        return sendJson(res, 502, { error: `Play 服务返回 ${up.status}` });
      }

      // 队列里先挂一条实时任务的，用户在面板上能看到「正在下 65 MB」，
      // 而不是点了之后一片安静。名字用卡片上的应用名，别拿包名糊上去
      const title = String(url.searchParams.get('name') || '').trim().slice(0, 120);
      if (title) appNames.remember(pkg, title);
      const tracking = trackTransfer({
        name: `${pkg}.apk`,
        title,
        platform: 'android',
        // 失败后「重试」要能重跑同一条：队列压不住 Play，只能把参数记在任务上
        retry: { kind: 'play', pkg, arch, title },
        onCancel: () => up.stream.destroy(new Error('canceled')),
      });
      let settled = false;

      // success 之后把临时文件落盘并收尾同一条任务，代价是后端多拷一份，
      // 好处是用户不用当场接住浏览器弹的下载，晚点来列表里还在
      return pipeSseTap(
        req,
        res,
        up,
        (evt) => {
          if (evt.type === 'progress') tracking.progress(evt.bytes, evt.bytesTotal);
          else if (evt.type === 'error') {
            settled = true;
            tracking.fail(evt.message, evt.code);
          } else if (evt.type === 'success' && evt.download_id) {
            settled = true;
            adoptPlayApk(evt.download_id, evt.filename, tracking).catch(() => {});
          }
        },
        () => {
          // 客户端走了（关弹窗不触发，关标签/刷新才会）。这里只留个痕迹：
          // 传输继续跑，进度继续往队列里写，成功后照样落盘——用户回来还能在列表里拿到。
          // 要中止只能从队列面板点「取消」，那是另一条路径。
          if (!settled) console.log(`[queue] Play ${pkg} 的客户端断开了，继续在后台跑`);
        },
        { abortOnClose: false }
      );
    }

    if (url.pathname === '/api/play/file') {
      return handlePlayFile(req, res, url.searchParams);
    }

    /* ---------------- Apple / ipatool（登录 / 版本 / 下载） ---------------- */

    if (url.pathname === '/api/apple/status') {
      return sendJson(res, 200, await apple.status());
    }

    if (url.pathname === '/api/apple/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await apple.login({ email: body.email, password: body.password, code: body.code });
      // 登录成功顺手登记进多账号清单。这里不抓会话快照（那会弹钥匙串授权），
      // 真要保会话是「多账号」里添加账号时做的事
      if (out.ok) {
        try {
          await appleAccounts.register({
            email: out.email || body.email,
            password: body.password || '',
            label: String(body.label || '').slice(0, 24),
            region: String(body.region || '').slice(0, 8),
            name: out.name || '',
            captureSession: false,
          });
        } catch {
          /* 登记失败不该影响登录本身 */
        }
      }
      // 「需要 2FA」「验证码不对」都不是错误，是流程中的一步，用 200 让前端接着走
      const normal = out.ok || out.needs2fa || out.badCode;
      return sendJson(res, normal ? 200 : 400, out);
    }

    if (url.pathname === '/api/apple/logout' && req.method === 'POST') {
      return sendJson(res, 200, await apple.logout());
    }

    /* ---------------- 多个 Apple ID（国服 / 美服…） ---------------- */

    if (url.pathname === '/api/apple/accounts') {
      // 顺带把当前 ipatool 会话的真实账号带出去，前端好判断「清单和实际是否一致」
      const st = await apple.status();
      let state = appleAccounts.list();
      // 老用户升级上来时清单是空的，但 ipatool 已经登录着——把当前账号补登记，
      // 否则切走之后就没有回程票了。不抓快照，免得看列表就弹授权框
      if (!state.accounts.length && st.authed && st.email) {
        await appleAccounts.register({ email: st.email, name: st.name || '', captureSession: false });
        state = appleAccounts.list();
      }
      return sendJson(res, 200, { ...state, current: st.authed ? st.email : '' });
    }

    // 添加账号：和 /api/apple/login 同一套登录流程，多了备注和区域。
    // 登录成功后抓一份钥匙串快照——macOS 会弹一次授权，点「允许」即可
    if (url.pathname === '/api/apple/accounts/add' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await apple.login({ email: body.email, password: body.password, code: body.code });
      if (!out.ok) {
        const normal = out.needs2fa || out.badCode;
        return sendJson(res, normal ? 200 : 400, out);
      }
      const reg = await appleAccounts.register({
        email: out.email || body.email,
        password: body.password || '',
        label: String(body.label || '').slice(0, 24),
        region: String(body.region || '').slice(0, 8),
        name: out.name || '',
        captureSession: true,
      });
      return sendJson(res, 200, {
        ...out,
        captured: reg.captured,
        captureError: reg.captured ? '' : reg.captureError || '会话快照没抓到（钥匙串授权没通过）',
      });
    }

    if (url.pathname === '/api/apple/accounts/switch' && req.method === 'POST') {
      // 下载中不让切：正在跑的 ipatool 用的就是这份会话，换掉必炸
      if (apple.isBusy()) {
        return sendJson(res, 409, {
          ok: false,
          message: '有 Apple 下载正在进行，等它跑完再切账号（切换会替换 ipatool 的会话）',
        });
      }
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim();
      const out = await appleAccounts.switchTo(email);

      // 目标没有快照：如果登记过密码，就自动重登一次（可能要 2FA）
      if (!out.ok && out.code === 'no_session') {
        const pwd = appleAccounts.getPassword(email);
        if (!pwd) {
          return sendJson(res, 400, {
            ...out,
            needsPassword: true,
            message: '这个账号还没有会话快照，也没有存密码——在下面填密码登录一次就能切过去',
          });
        }
        const lo = await apple.login({ email, password: pwd, code: body.code });
        if (lo.ok) {
          await appleAccounts.register({ email, password: pwd, captureSession: true });
          const st = await apple.status();
          return sendJson(res, 200, {
            ok: true,
            email: st.email || email,
            active: email,
            sessionOk: st.authed,
            warn: out.warn || '',
            message: '',
          });
        }
        const normal = lo.needs2fa || lo.badCode;
        return sendJson(res, normal ? 200 : 400, { ...lo, needs2fa: lo.needs2fa, email, warn: out.warn || '' });
      }

      if (!out.ok) return sendJson(res, 400, out);

      // 换完会话再问一次 ipatool：快照可能已过期，报错要让人看见
      const st = await apple.status();
      return sendJson(res, 200, {
        ok: st.authed,
        email: st.email || out.account.email,
        active: out.account.email,
        sessionOk: st.authed,
        warn: out.warn || '',
        message: st.authed ? '' : st.error || '会话已过期，需要用密码重新登录一次',
      });
    }

    if (url.pathname === '/api/apple/accounts/remove' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = appleAccounts.remove(body.email);
      return sendJson(res, out.ok ? 200 : 400, out);
    }

    // 钥匙串里的 Apple ID：ipatool 存的会话 / 登录钥匙串里的网页密码 / 本机 iCloud 账号。
    // 密码本体不出这个接口，只回 hasPassword，真正要用时走下面的 keychain-login。
    if (url.pathname === '/api/apple/keychain') {
      return sendJson(res, 200, { items: await apple.keychainItems() });
    }

    // 真正把密码取出来：会弹 macOS 的系统授权框（输本机登录密码 = 管理员验证）
    if (url.pathname === '/api/apple/keychain-fill' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await apple.fillPassword(String(body.id || ''));
      return sendJson(res, out.ok ? 200 : 400, out);
    }

    if (url.pathname === '/api/apple/keychain-login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await apple.loginFromKeychain({
        id: String(body.id || ''),
        code: body.code,
      });
      // needsPassword 也不是错误：前端拿它把账号回填到输入框
      const normal = out.ok || out.needs2fa || out.badCode || out.needsPassword;
      return sendJson(res, normal ? 200 : 400, out);
    }

    /* ---------------- Android 历史版本（Aptoide 索引，降级用） ---------------- */

    if (url.pathname === '/api/android/versions') {
      const pkg = String(url.searchParams.get('pkg') || '').trim();
      if (!PACKAGE_ID.test(pkg)) return sendJson(res, 400, { error: 'bad package name' });
      const ch = sseChannel(req, res);
      try {
        await aptoideVersions(pkg, (evt) => ch.emit(evt));
      } catch (e) {
        ch.emit({ type: 'error', message: String(e.message || e) });
      } finally {
        ch.close();
      }
      return undefined;
    }

    if (url.pathname === '/api/android/download') {
      const pkg = String(url.searchParams.get('pkg') || '').trim();
      const code = Number(url.searchParams.get('vercode')) || 0;
      if (!PACKAGE_ID.test(pkg) || !code) return sendJson(res, 400, { error: 'bad params' });
      let v;
      try {
        v = await aptoideVersionUrl(pkg, code);
      } catch (e) {
        return sendJson(res, 502, { error: String(e.message || e) });
      }
      if (!v.url) return sendJson(res, 404, { error: '这个版本在 Aptoide 上没有可下的包' });
      // 复用统一下载通道：代理回退、文件名、断点都由它处理
      return handleDownload(
        req,
        res,
        new URLSearchParams({ u: v.url, n: `${pkg}-${v.version || code}.apk` })
      );
    }

    if (url.pathname === '/api/apple/versions') {
      const bundle = String(url.searchParams.get('bundle') || '').trim();
      if (!BUNDLE_ID.test(bundle)) return sendJson(res, 400, { error: 'bad bundle id' });
      const plat = pickPlatform(url.searchParams.get('platform'));
      const limit = Number(url.searchParams.get('limit')) || 0;
      return appleVersionsSse(req, res, bundle, plat, limit);
    }

    if (url.pathname === '/api/apple/resolve') {
      const u = String(url.searchParams.get('u') || '').trim();
      if (!u) return sendJson(res, 400, { error: 'missing u' });
      if (u.length > 2000) return sendJson(res, 400, { error: 'url too long' });
      try {
        const out = await appleResolve(u);
        return sendJson(res, out.ok ? 200 : 400, out);
      } catch (e) {
        // 「地址被挡」是策略问题（403），抓不到页面才是上游问题（502）
        const blocked = /blocked|dns lookup failed/i.test(String(e.message || ''));
        return sendJson(res, blocked ? 403 : 502, { ok: false, error: String(e.message || e) });
      }
    }

    if (url.pathname === '/api/apkpure') {
      const pkg = String(url.searchParams.get('pkg') || '').trim();
      if (!/^[A-Za-z0-9._]{2,200}$/.test(pkg)) return sendJson(res, 400, { error: 'bad package' });
      const d = await apkpure.detail(pkg, { fresh: url.searchParams.has('fresh') });
      return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'APKPure 没有这个包' });
    }

    if (url.pathname === '/api/apple/download') {
      const bundle = String(url.searchParams.get('bundle') || '').trim();
      if (!BUNDLE_ID.test(bundle)) return sendJson(res, 400, { error: 'bad bundle id' });
      const plat = pickPlatform(url.searchParams.get('platform'));
      const versionId = String(url.searchParams.get('version') || '').trim();
      if (versionId && !/^\d{1,20}$/.test(versionId)) return sendJson(res, 400, { error: 'bad version id' });

      // 批量：versions=111,222,333。上限 10 个——每个都是几百 MB，再多就是几十 GB。
      const versionIds = String(url.searchParams.get('versions') || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (versionIds.length) {
        if (versionIds.length > 10) return sendJson(res, 400, { error: '一次最多下载 10 个版本' });
        if (versionIds.some((v) => !/^\d{1,20}$/.test(v))) {
          return sendJson(res, 400, { error: 'bad version id' });
        }
      }

      // 前端点「下载」时把卡片上的应用名带过来，先记进字典：
      // 这样无论是这次下载的队列条目，还是以后重启扫目录恢复的条目，都显示「奶茶人」
      const title = String(url.searchParams.get('name') || '').trim().slice(0, 120);
      if (title) appNames.remember(bundle, title);

      return appleDownloadSse(req, res, { bundle, plat, versionId, versionIds, title });
    }

    if (url.pathname === '/api/backends') {
      return sendJson(res, 200, await detectBackends(url.searchParams.has('refresh')));
    }

    if (url.pathname === '/api/local' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const out = await runLocalDownload(String(body.tool || ''), String(body.id || ''));
      return sendJson(res, out.ok ? 200 : out.code === 'download_capacity' ? 507 : 400, out);
    }

    if (url.pathname === '/api/file') {
      return serveDownloadFile(req, res, url.searchParams.get('name'));
    }

    /* ---------------- 已连接的手机（adb / pymobiledevice3） ---------------- */

    if (url.pathname === '/api/devices') {
      const out = await devices.detect(url.searchParams.has('refresh'));
      return sendJson(res, 200, out);
    }

    /* ---------------- 本机下载队列 ---------------- */

    if (url.pathname === '/api/queue' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const raw = String(body.u || '').trim();
      if (!raw) return sendJson(res, 400, { error: 'missing u' });

      let target;
      try {
        target = new URL(raw);
      } catch {
        return sendJson(res, 400, { error: 'invalid url' });
      }
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return sendJson(res, 400, { error: 'only http(s) allowed' });
      }
      try {
        await assertPublicHost(target.hostname);
      } catch (e) {
        return sendJson(res, 403, { error: String(e.message || e) });
      }

      const platform = String(body.platform || '');
      const installReq = body.install && body.install.device
        ? {
            platform: String(body.install.platform || platform),
            device: String(body.install.device),
            name: String(body.install.name || '').slice(0, 80),
          }
        : null;

      const job = downloadQueue.add({
        url: raw,
        name: sanitizeFilename(body.n || body.name || decodeURIComponent(path.basename(target.pathname))),
        // t = 应用名（「微信」），n 是文件名（com.tencent.mm-8.0.49.apk）。
        // 两个都留着，列表里显示前者、保存时用后者
        title: String(body.t || body.title || '').trim().slice(0, 120),
        platform,
        install: installReq,
      });
      return sendJson(res, 200, { ok: true, job });
    }

    if (url.pathname === '/api/queue') {
      // 队列会被前端高频轮询，这里绝不能顺带探设备——adb/pymobiledevice3 每探一次
      // 都要起进程，几秒一次会把 CPU 拖垮。设备状态由 /api/devices 单独提供。
      return sendJson(res, 200, {
        jobs: downloadQueue.list(),
        stats: downloadQueue.stats(),
        dir: DOWNLOAD_DIR,
      });
    }

    if (url.pathname === '/api/queue/retry' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      if (!id) return sendJson(res, 400, { error: 'id required' });
      const out = retryJob(id);
      if (out.error) return sendJson(res, out.code === 'download_capacity' ? 507 : 400, { error: out.error });
      return sendJson(res, 200, out);
    }

    if (url.pathname === '/api/queue/cancel' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { ok: downloadQueue.cancel(String(body.id || '')) });
    }

    if (url.pathname === '/api/queue/clear' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true, jobs: downloadQueue.clear() });
    }

    // 单条移除：前端原来只把它从本地数组里 filter 掉，服务端不知道，
    // 下一次轮询又原样拉回来——点了像没点
    if (url.pathname === '/api/queue/drop' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      if (!id) return sendJson(res, 400, { error: 'id required' });
      downloadQueue.drop(id);
      return sendJson(res, 200, { ok: true, jobs: downloadQueue.list() });
    }

    // 装已经在本机的包（队列里下完的、ipatool 取的、apkeep 下的都走这里）
    if (url.pathname === '/api/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const file = path.basename(String(body.file || ''));
      const platform = String(body.platform || '');
      const device = String(body.device || '');
      if (!file || !device) return sendJson(res, 400, { error: 'file and device required' });
      if (!['android', 'ios'].includes(platform)) return sendJson(res, 400, { error: 'bad platform' });
      if (!devices.safeFile(DOWNLOAD_DIR, file)) return sendJson(res, 400, { error: 'bad file' });
      const job = downloadQueue.add({
        file,
        name: file,
        platform,
        kind: 'install',
        install: { platform, device, name: String(body.deviceName || '').slice(0, 80) },
      });
      return sendJson(res, 200, { ok: true, job });
    }

    // 在访达 / 资源管理器里定位文件：下完几十个包之后，用户不想自己翻目录
    if (url.pathname === '/api/reveal' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const full = devices.safeFile(DOWNLOAD_DIR, body.name);
      if (!full || !fs.existsSync(full)) return sendJson(res, 404, { error: 'not found' });
      const cmd =
        process.platform === 'darwin'
          ? ['open', ['-R', full]]
          : process.platform === 'win32'
            ? ['explorer', ['/select,', full]]
            : ['xdg-open', [path.dirname(full)]];
      execFile(cmd[0], cmd[1], () => {});
      return sendJson(res, 200, { ok: true });    }

    if (url.pathname === '/api/health') {
      let casks = 0;
      try {
        casks = (await loadCasks()).length;
      } catch {
        casks = -1;
      }
      const netInfo = await proxyStatus();
      return sendJson(res, 200, {
        ok: true,
        port: PORT,
        githubToken: Boolean(await ghToken()),
        casks,
        proxy: netInfo.proxy,
        directHosts: netInfo.directHosts,
        play: await gplay.status(),
        apple: await apple.status(),
        winget: winget.status(),
        queue: downloadQueue.stats(),
        downloadStorage: {
          used: downloadQueue.usage(),
          limit: downloadQueue.maxBytes,
        },
        devices: (await devices.detect()).devices.length,
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }

    return serveStatic(req, res, url.pathname);
  } catch (e) {
    return sendJson(res, e.code === 'download_capacity' ? 507 : 500, {
      error: String(e.message || e),
      ...(e.code ? { code: e.code } : {}),
    });
  }
});

if (require.main === module) {
  const loopback = LOOPBACK_HOSTS.has(BIND_HOST);
  if (!loopback && REMOTE_TOKEN.length < 32) {
    console.error(
      `拒绝监听非回环地址 ${BIND_HOST}：请设置至少 32 个字符的 ANYPKG_REMOTE_TOKEN。`
    );
    process.exit(1);
  }
  // 默认只本机可访问；HOST=0.0.0.0 时放开给局域网（用手机直接打开页面下 APK）
  server.listen(PORT, BIND_HOST, () => {
    console.log(`任意包 running → http://localhost:${PORT}`);
    restoreQueueFromDisk();
    ghToken().then((t) => {
      console.log(`GitHub token: ${t ? (GH_TOKEN_ENV ? '来自环境变量' : '借本机 gh 登录态') : '未配置（搜索限速 10 次/分钟）'}`);
    });
  });

  // 启动就预载 cask 索引（19MB），免得第一次搜索干等
  loadCasks()
    .then((list) => console.log(`Homebrew Cask 索引就绪：${list.length} 个应用`))
    .catch((e) => console.warn('Homebrew Cask 索引加载失败：', e.message));

  // Izzy 的索引压完只有 449KB，装进内存后搜索就是一次数组过滤（几十毫秒）。
  // 过期时 loadIndex 会先返回旧数据、后台再刷新，这里只是把它提前到启动时
  izzy
    .loadIndex()
    .then((list) => console.log(`IzzyOnDroid 索引就绪：${list.length} 个应用`))
    .catch((e) => console.warn('IzzyOnDroid 索引加载失败：', e.message));

  // Play 旁路服务异步拉起：首次要建 gsfId，不能让首屏搜索陪着等
  gplay
    .ensure()
    .then(async (ok) => {
      if (!ok) return console.log('Google Play 旁路未就绪（不影响其它源）');
      const st = await gplay.status();
      console.log(
        st.authenticated
          ? `Google Play 就绪：${st.email || '已登录'}`
          : 'Google Play 就绪：未登录，点页面上的「连接账号」'
      );
    })
    .catch((e) => console.warn('Google Play 旁路启动失败：', e.message));

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      gplay.shutdown();
      process.exit(0);
    });
  }

}

module.exports = { assetLabel, relevance, fmtSize, aggregate, server, runSource };
