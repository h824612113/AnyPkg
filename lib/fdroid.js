'use strict';

/**
 * F-Droid：开源 Android 应用仓库，免登录、免签名、直链。
 *
 * 为什么不啃 index-v2.json（15MB 的索引）：
 *   - search.f-droid.org 的搜索结果页是纯静态 HTML，结构稳、体积 5KB；
 *   - 版本号再打一次 /api/v1/packages/<pkg>，单个包几十 KB。
 * 索引适合做全量离线库，而这里只需要「一次搜索」。
 *
 * 直链规律 <repo>/<pkg>_<versionCode>.apk 是 F-Droid 自己的产物命名约定，
 * 绝大多数包适用；少数自带 apkName 的包会 404，下载时会把上游状态码透出来。
 */

const { smartText, smartJson } = require('./net');

const UA = 'AnyPkg/0.5 (local meta-search)';
const REPO = 'https://f-droid.org/repo';

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 搜索结果块长这样（属性顺序可能变，所以先按 class 切块再各自提字段）：
 *   <a class="package-header" href="https://f-droid.org/en/packages/<pkg>">
 *     <img class="package-icon" src="...">
 *     <h4 class="package-name">名称</h4>
 *     <span class="package-summary">简介</span><span class="package-license">Apache-2.0</span>
 */
function parseSearch(html) {
  const out = [];
  const chunks = String(html).split('<a class="package-header"');
  for (const chunk of chunks.slice(1)) {
    const pkg = chunk.match(/\/packages\/([A-Za-z0-9._]+)/)?.[1] || '';
    if (!pkg) continue;
    const name = decodeEntities(chunk.match(/class="package-name">\s*([\s\S]*?)\s*<\/h4>/)?.[1] || pkg).trim();
    const summary = decodeEntities(chunk.match(/class="package-summary">([\s\S]*?)<\/span>/)?.[1] || '').trim();
    const license = decodeEntities(chunk.match(/class="package-license">([\s\S]*?)<\/span>/)?.[1] || '').trim();
    const icon = chunk.match(/class="package-icon" src="([^"]+)"/)?.[1] || '';
    out.push({ pkg, name, summary, license, icon });
  }
  return out;
}

async function search(term) {
  const html = await smartText(
    `https://search.f-droid.org/?q=${encodeURIComponent(term)}&lang=en`,
    { timeout: 12000, headers: { 'user-agent': UA, accept: 'text/html' }, maxBytes: 2 * 1024 * 1024 }
  );
  return parseSearch(html).slice(0, 14);
}

/** 版本列表：新版本在前，suggestedVersionCode 就是仓库里当前推荐的版本 */
async function versions(pkg) {
  const data = await smartJson(`https://f-droid.org/api/v1/packages/${encodeURIComponent(pkg)}`, {
    timeout: 9000,
    headers: { 'user-agent': UA },
  });
  return {
    suggested: Number(data.suggestedVersionCode) || 0,
    list: (data.packages || []).map((p) => ({
      version: p.versionName || '',
      code: Number(p.versionCode) || 0,
    })),
  };
}

function apkUrl(pkg, code) {
  return `${REPO}/${pkg}_${code}.apk`;
}

/** 给聚合层用的统一 item 结构 */
async function source(term, { relevance } = {}) {
  const found = await search(term);
  if (!found.length) return [];

  // 版本信息只补最相关的前 6 个：每多一个就是一次跨洋请求
  const ranked = found
    .map((a) => ({ a, rel: relevance ? relevance(a.name, term) : 0 }))
    .sort((x, y) => y.rel - x.rel)
    .slice(0, 6);

  const detailed = await Promise.all(
    ranked.map(async (row) => {
      try {
        return { ...row, v: await versions(row.a.pkg) };
      } catch {
        return { ...row, v: null };
      }
    })
  );

  return detailed
    .filter((row) => row.v && row.v.list.length)
    .map(({ a, rel, v }) => {
      const top = v.list.find((x) => x.code === v.suggested) || v.list[0];
      const filename = `${a.pkg}_${top.code}.apk`;
      return {
        id: `fdroid:${a.pkg}`,
        name: a.name,
        publisher: 'F-Droid（开源）',
        packageId: a.pkg,
        version: top.version,
        icon: a.icon,
        summary: a.summary,
        tags: [a.pkg],
        platforms: ['android'],
        meta: [top.version ? `v${top.version}` : '', a.license, `${v.list.length} 个版本`].filter(Boolean),
        price: '免费',
        updated: '',
        source: 'F-Droid',
        sourceUrl: `https://f-droid.org/packages/${a.pkg}/`,
        trust: a.license ? `开源 ${a.license}` : '开源',
        rel,
        downloads: [
          {
            label: `${filename}（F-Droid）`,
            short: `F-Droid · v${top.version || top.code}`,
            url: apkUrl(a.pkg, top.code),
            kind: 'direct',
            platform: 'android',
            filename,
          },
        ],
      };
    });
}

module.exports = { search, versions, apkUrl, source, parseSearch };
