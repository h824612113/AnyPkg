'use strict';

/**
 * Flathub：Linux 桌面最大的应用仓库，公开接口、免登录。
 *
 * 搜索只有 POST 一个入口（GET 直接 405），返回的 hit 里已经带了 app_id / 图标 /
 * 开发者 / 月安装量，一次请求就够，不用再查 appstream 详情。
 *
 * 下载给的是 `.flatpakref` 而不是 `.flatpak`：Flathub 走 OSTree 分发，官方并不为
 * 每个应用提供单文件 bundle，仓库里只有 ref 这种「指向仓库的安装凭据」。
 * 这个文件是 `flatpak install --from <文件>` 的合法输入，所以仍然算直下，
 * 只是按钮得写清楚它是什么，别让人以为下到了几百 MB 的安装包。
 */

const { smartPostJson } = require('./net');

const UA = 'AnyPkg/0.8 (local meta-search)';
const API = 'https://flathub.org/api/v2';
const REPO = 'https://dl.flathub.org/repo/appstream';
const PICK = 5;

const SEARCH_TTL = 10 * 60 * 1000;
const FAIL_TTL = 60 * 1000;
const MAX_CACHE = 500;
const cache = new Map();

function trimCache() {
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

async function search(term) {
  const key = term.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || SEARCH_TTL)) {
    if (hit.err) throw hit.err;
    return hit.data;
  }
  try {
    const data = await smartPostJson(
      `${API}/search`,
      { query: term, hitsPerPage: 20, page: 1 },
      { timeout: 8000, headers: { 'user-agent': UA, origin: 'https://flathub.org' } }
    );
    const hits = data?.hits || [];
    cache.set(key, { at: Date.now(), data: hits, ttl: SEARCH_TTL });
    trimCache();
    return hits;
  } catch (err) {
    cache.set(key, { at: Date.now(), err, ttl: FAIL_TTL });
    trimCache();
    throw err;
  }
}

/** Flathub 的 app_id 常与显示名不一致（Bottles → com.usebottles.bottles），两处都要算相关度 */
function deepRelevance(h, term, relevance) {
  if (!relevance) return 0;
  const byName = relevance(h.name || '', term);
  const idTail = String(h.app_id || '').split('.').pop().replace(/[-_]/g, ' ');
  const byId = relevance(idTail, term);
  return Math.max(byName, byId);
}

async function source(term, { relevance } = {}) {
  const hits = await search(term);
  if (!hits.length) return [];

  return hits
    .map((h) => ({ h, rel: deepRelevance(h, term, relevance), installs: Number(h.installs_last_month) || 0 }))
    .filter((x) => x.rel > 0)
    .sort((a, b) => b.rel - a.rel || b.installs - a.installs)
    .slice(0, PICK)
    .map(({ h, rel }) => {
      const id = h.app_id;
      const name = h.name || id;
      const arches = Array.isArray(h.arches) && h.arches.length ? h.arches.join(' / ') : '';
      const installs = Number(h.installs_last_month) || 0;

      return {
        id: `flathub:${id}`,
        name,
        publisher: h.developer_name || '',
        version: '',
        icon: h.icon || '',
        summary: h.summary || '',
        tags: [id],
        platforms: ['linux'],
        meta: [
          installs ? `${fmtCount(installs)}/月安装` : '',
          arches,
          h.verification_verified ? '已验证' : '',
        ].filter(Boolean),
        // 月安装量既是展示也是排序依据；Linux 桌面的基数比手机小两个数量级，
        // 所以这里不折算成年化，就让它在 install 刻度上偏低——这是事实，不该补贴
        pop: installs,
        popUnit: 'install',
        popLabel: '次安装/月',
        price: '免费',
        updated: h.updated_at ? String(h.updated_at).slice(0, 10) : '',
        source: 'Flathub',
        sourceUrl: `https://flathub.org/apps/${id}`,
        trust: h.verification_verified ? '发布者已验证' : 'Flathub 官方仓库',
        rel,
        downloads: [
          {
            label: `${name} · flatpakref（flatpak install --from 这个文件）`,
            short: 'Linux · flatpakref',
            url: `${REPO}/${id}.flatpakref`,
            kind: 'direct',
            platform: 'linux',
            filename: `${id}.flatpakref`,
            origin: 'flathub',
            size: '',
          },
        ],
      };
    })
    .filter(Boolean);
}

function fmtCount(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

module.exports = { source, search };
