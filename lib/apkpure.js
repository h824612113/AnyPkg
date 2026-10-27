'use strict';

/**
 * APKPure：第三方 APK 镜像。只走它 App 端的 tapi 接口，不碰网页。
 *
 * 为什么不去爬 apkpure.com：
 *   网页和 d.apkpure.com 的下载直链都在 Cloudflare 后面（实测 403 Just a moment），
 *   而 App 接口 tapi.pureapk.com/v3/get_app_detail 是明文 JSON，
 *   返回的 asset.url 更是已经带好了 token 的 data.winudf.com 直链——
 *   中间没有 JS 挑战，也不需要 cookie。
 *
 * 代价：
 *   - 没有可用的关键词搜索接口（/v3/search 要 App 的 protobuf 体，实测 400），
 *     所以它只做「已知包名」的补点，不参与关键词检索；
 *   - asset.url 里的 token 是带时间戳的短期凭证，必须每次现取，不能缓存链接。
 */

const { smartJson } = require('./net');

const ENDPOINT = 'https://tapi.pureapk.com/v3/get_app_detail';
const HEADERS = {
  'user-agent': 'APKPure/3.19.35 (Aegon)',
  'ual-access-businessid': 'projecta',
  accept: 'application/json',
};

const TTL = 10 * 60 * 1000;
const cache = new Map();
const MAX_CACHE = 500;

function trimCache() {
  while (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

function iconOf(a) {
  if (typeof a.icon === 'string' && a.icon) return a.icon;
  if (a.icon && typeof a.icon === 'object') return a.icon.url || a.icon.original || '';
  return a.icon_url || '';
}

function pick(a) {
  const asset = a.asset || {};
  return {
    pkg: a.package_name || '',
    realPkg: a.real_package_name || '',
    name: a.title || a.label || a.package_name || '',
    developer: a.developer || '',
    version: a.version_name || '',
    versionCode: String(a.version_code || ''),
    size: Number(asset.size) || 0,
    sha1: asset.sha1 || '',
    // "APK" 是整包，"XAPK" 是 base + split 的合集，装之前要先解压合并
    type: String(asset.type || 'APK').toUpperCase(),
    url: asset.url || '',
    sign: Array.isArray(a.sign) ? a.sign : [],
    icon: iconOf(a),
    summary: String(a.description_short || '').replace(/\s+/g, ' ').slice(0, 160),
    category: a.category_name || '',
    updated: String(a.update_date || '').slice(0, 10),
    downloads: Number(a.download_count) || 0,
    rating: Number(a.review_stars) || 0,
    off: Boolean(a.is_off_download),
  };
}

async function detail(pkg, { fresh = false } = {}) {
  const key = String(pkg || '').trim();
  if (!/^[A-Za-z0-9._]{2,200}$/.test(key)) return null;

  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value;

  let data;
  try {
    data = await smartJson(`${ENDPOINT}?package_name=${encodeURIComponent(key)}`, {
      timeout: 9000,
      headers: HEADERS,
    });
  } catch {
    // 网络抖动不该让整页搜索失败，这里当成「这个源没有」处理
    return null;
  }

  const a = data?.app_detail;
  if (!a || !a.package_name) return null;
  const value = pick(a);
  if (!value.url || value.off) return null;

  cache.set(key, { at: Date.now(), value });
  trimCache();
  return value;
}

/**
 * 给已有的 Android 卡片补一个 APKPure 直链。
 * 并发查 limit 个包，单个失败不影响其他——APKPure 只值这个价钱：
 * 它是「多一个下载通道」，不是主数据源，慢一点也不能拖垮首屏。
 */
async function enrich(items, { limit = 5, timeoutMs = 5000 } = {}) {
  const targets = items
    .filter((it) => (it.platforms || []).includes('android') && it.packageId)
    .filter((it) => !(it.downloads || []).some((d) => d.origin === 'apkpure'))
    // 缺热度的排前面：Play / 应用宝 / F-Droid 都不给下载量，而 APKPure 正好有。
    // 已经知道热度的卡片（Aptoide 会给 pdownloads）再补一遍是重复劳动，
    // 而 Play 卡片通常还同时缺一条直链——两边需求指向同一批，顺序就按这个来
    .sort((a, b) => Number(Boolean(a.pop)) - Number(Boolean(b.pop)))
    .slice(0, limit);

  await Promise.all(
    targets.map(async (it) => {
      const d = await Promise.race([
        detail(it.packageId),
        new Promise((r) => setTimeout(() => r(null), timeoutMs)),
      ]);
      if (!d || !d.url) return;

      const isSplit = d.type === 'XAPK';
      const filename = `${it.packageId}-${d.version || 'app'}.${isSplit ? 'xapk' : 'apk'}`;
      it.downloads = it.downloads || [];
      it.downloads.push({
        label: `${filename}（APKPure${isSplit ? ' · 分包合集' : ''}）`,
        short: `APKPure · v${d.version || '?'}${isSplit ? ' XAPK' : ''}`,
        url: d.url,
        kind: 'direct',
        platform: 'android',
        size: d.size ? `${(d.size / 1024 / 1024).toFixed(1)} MB` : '',
        filename,
        version: d.version,
        origin: 'apkpure',
      });

      // 同一个包名在 APKPure 上有签名哈希，能当「文件是不是被改过」的锚点
      if (d.sign[0] && !it.trust) it.trust = `APKPure 签名 ${d.sign[0].slice(0, 8)}…`;
      if (!it.icon && d.icon) it.icon = d.icon;
      if (!it.summary && d.summary) it.summary = d.summary;

      // Play / F-Droid 这类源不提供热度，APKPure 的下载量正好补上这块空白。
      // 只在没有热度时填：应用宝给的是全渠道累计（微信 200 亿+），APKPure 只统计自己站内，
      // 两者口径不同，覆盖会让国民级应用被算成「几百万」。
      if (d.downloads > 0 && !(Number(it.pop) > 0)) {
        it.pop = d.downloads;
        it.popUnit = 'install';
        // 记下这个数字是哪来的：卡片标题写的是「应用宝」，热度却是 APKPure 的站内下载量，
        // 不标出处在悬停提示里会让人以为应用宝统计的
        it.popFrom = 'APKPure';
      }
      if (d.rating > 0 && !it.rating) {
        it.rating = { score: Number(d.rating.toFixed(1)), count: 0 };
      }
      it.sources = [...new Set([...(it.sources || [it.source]), 'APKPure'])];
    })
  );

  return items;
}

module.exports = { detail, enrich };
