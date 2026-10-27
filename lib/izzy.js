'use strict';

/**
 * IzzyOnDroid：F-Droid 的第三方仓库，1400+ 个开源 Android 应用，免账号、直链。
 *
 * 为什么要加它而不是再找一家镜像站：
 *   - 官方 F-Droid 的收录标准很严（不允许非自由依赖、不允许某些商标），
 *     于是 NewPipe 的各种 fork、各家开源客户端都跑到了 Izzy 这边；
 *   - 它同样遵循 F-Droid 仓库协议，包名、sha256、签名都能拿到，
 *     下载地址就是 `<repo>/<apkName>`，和官方仓库一个套路。
 *
 * 为什么这里啃索引、而官方 F-Droid 用网页搜索：
 *   Izzy 没有 search.f-droid.org 那样的静态搜索页（/fdroid/index/search 是坏的），
 *   只有 index-v1.json。16MB 一次性拿下来、压成 1400 条精简记录，落盘缓存 6 小时，
 *   之后每次搜索都是内存过滤，比一个个去抓网页快得多。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { smartText } = require('./net');

const UA = 'AnyPkg/0.6 (local meta-search)';
const INDEX_URL = 'https://apt.izzysoft.de/fdroid/repo/index-v1.json';
const REPO = 'https://apt.izzysoft.de/fdroid/repo';
const CACHE_FILE = path.join(__dirname, '..', '.cache', 'izzy.json');
const TTL = 6 * 60 * 60 * 1000;

let indexPromise = null;
let indexCache = null; // 内存副本：命中的搜索只做内存过滤，几十毫秒
let loadedAt = 0;
let failedAt = 0; // 刷新失败的冷却时间，避免每次搜索都去撞同一个超时

/**
 * 拉 16MB 索引并落盘。跨洋链路顺利时 3~6s，遇上抽风会超过 20s——
 * 而 runSource 的预算是 20s，同步等它等于让整个源判超时。
 */
function refreshIndex() {
  if (indexPromise) return indexPromise;

  indexPromise = (async () => {
    // 16MB 的索引，默认 8MB 上限不够；给足 45s
    const body = await smartText(INDEX_URL, {
      timeout: 45000,
      maxBytes: 24 * 1024 * 1024,
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    const list = compact(JSON.parse(body));

    try {
      await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await fsp.writeFile(CACHE_FILE, JSON.stringify(list));
    } catch {
      /* 缓存写失败不影响本次使用 */
    }

    indexCache = list;
    loadedAt = Date.now();
    return list;
  })()
    .catch((e) => {
      failedAt = Date.now();
      throw e;
    })
    .finally(() => {
      indexPromise = null;
    });

  return indexPromise;
}

async function loadIndex() {
  if (indexCache && Date.now() - loadedAt < TTL) return indexCache;

  // 缓存过期（或进程刚起）时先把磁盘上的旧索引拿来用，后台再刷新。
  // 这一条是 Izzy 不再随机「超时 20s」的关键：搜索结果晚几个小时更新没人会在意，
  // 但少一整个源、而且每次搜索都卡 20s，是能直接看出来的
  if (!indexCache) {
    try {
      const st = await fsp.stat(CACHE_FILE);
      const list = JSON.parse(await fsp.readFile(CACHE_FILE, 'utf8'));
      indexCache = list;
      loadedAt = st.mtimeMs;
    } catch {
      /* 没缓存，只能同步拉 */
    }
  }

  if (indexCache) {
    const expired = Date.now() - loadedAt >= TTL;
    const cooling = Date.now() - failedAt < 5 * 60 * 1000;
    if (expired && !cooling) refreshIndex().catch(() => {});
    return indexCache;
  }

  return refreshIndex();
}

function localized(app, key) {
  const loc = app.localized || {};
  const hit = loc['en-US'] || loc['en-GB'] || Object.values(loc)[0] || {};
  return String(hit[key] || '');
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 索引里 packages[pkg] 是一个版本数组，建议版本用 suggestedVersionCode 标出来 */
function newestPackage(app, packs) {
  const list = Array.isArray(packs) ? packs : [];
  if (!list.length) return null;
  const want = String(app.suggestedVersionCode || '');
  const sorted = list.slice().sort((a, b) => (Number(b.added) || 0) - (Number(a.added) || 0));
  const hit = want ? sorted.find((p) => String(p.versionCode || '') === want) : null;
  return hit || sorted[0];
}

function compact(raw) {
  const packs = raw.packages || {};
  const out = [];
  for (const app of raw.apps || []) {
    const pkg = String(app.packageName || '');
    const p = newestPackage(app, packs[pkg]);
    if (!pkg || !p || !p.apkName) continue;

    // apkName 的命名是 <pkg>_<versionCode>.apk，版本号本身不在索引里，
    // 真实 versionName 要解包才知道，所以这里只用构建号，别假装是版本号
    const code = String(p.versionCode || (p.apkName.match(/_(\d+)\.apk$/) || [])[1] || '');
    out.push({
      pkg,
      name: localized(app, 'name') || pkg,
      summary: stripHtml(localized(app, 'summary') || localized(app, 'description')).slice(0, 160),
      icon: app.icon ? `${REPO}/icons/${app.icon}` : '',
      license: String(app.license || ''),
      code,
      apk: String(p.apkName),
      size: Number(p.size) || 0,
      hash: String(p.hash || ''),
      updated: Number(app.lastUpdated) || 0,
    });
  }
  return out;
}

function score(app, term) {
  const q = String(term || '').toLowerCase().trim();
  if (!q) return 0;
  const name = app.name.toLowerCase();
  const pkg = app.pkg.toLowerCase();

  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  // 包名命中通常是「知道自己在找什么」的开发者，给个中等分
  if (pkg.includes(q)) return 40;
  if (app.summary.toLowerCase().includes(q)) return 10;
  return 0;
}

async function search(term) {
  const list = await loadIndex();
  return list
    .map((app) => ({ app, rel: score(app, term) }))
    .filter((x) => x.rel > 0)
    .sort((a, b) => b.rel - a.rel || b.app.updated - a.app.updated)
    .slice(0, 12)
    .map((x) => x.app);
}

function fmtSize(n) {
  if (!n) return '';
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

async function source(term, { relevance } = {}) {
  const found = await search(term);
  if (!found.length) return [];

  return found.slice(0, 6).map((a) => {
    const filename = a.apk;
    return {
      id: `izzy:${a.pkg}`,
      name: a.name,
      publisher: 'IzzyOnDroid（开源仓库）',
      packageId: a.pkg,
      // 索引里没有 versionName：留空，合并时就不会去抢官方 F-Droid / 应用宝的主卡片位
      version: '',
      icon: a.icon,
      summary: a.summary,
      tags: [a.pkg],
      platforms: ['android'],
      meta: [a.code ? `build ${a.code}` : '', fmtSize(a.size), a.license].filter(Boolean),
      price: '免费',
      updated: a.updated ? new Date(a.updated).toISOString().slice(0, 10) : '',
      source: 'IzzyOnDroid',
      sourceUrl: `https://apt.izzysoft.de/fdroid/index/apk/${encodeURIComponent(a.pkg)}`,
      trust: a.license ? `开源 ${a.license}` : '开源',
      rel: relevance ? relevance(a.name, term) : 0,
      downloads: [
        {
          label: `${filename}（IzzyOnDroid）`,
          short: a.code ? `Izzy · build ${a.code}` : 'IzzyOnDroid',
          url: `${REPO}/${filename}`,
          kind: 'direct',
          platform: 'android',
          filename,
          sha256: a.hash || undefined,
        },
      ],
    };
  });
}

module.exports = { search, source, loadIndex };
