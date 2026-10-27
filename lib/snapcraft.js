'use strict';

/**
 * Snapcraft：Linux 桌面应用，公开接口、免登录、单文件 .snap 直下。
 *
 * 接口分两步，成本和收益差很多：
 *   find  → 一次请求拿到 name / 版本 / revision / snap-id / 体积（`fields` 里要有 revision）
 *   info  → 再查一次才有 channel-map（架构、真实下载地址、sha3-384）
 *
 * 关键是：find 里的 `revision` + `snap-id` 已经能拼出下载地址
 *   https://api.snapcraft.io/api/v1/snaps/download/<snap-id>_<revision>.snap
 * 所以 info 只用来补「架构」这种锦上添花的信息。info 被限流（429）或变慢时，
 * 直接退回拼出来的地址，功能不降级——之前踩过：5 个 info 并发里有一个卡 11 秒，
 * 整个源就跟着超时，一栏全空。
 *
 * 只取 stable 通道：edge / beta 是开发者自己推的构建，给普通用户等于埋雷。
 */

const { smartJson } = require('./net');

const UA = 'AnyPkg/0.7 (local meta-search)';
const API = 'https://api.snapcraft.io/v2';
const DOWNLOAD = 'https://api.snapcraft.io/api/v1/snaps/download';
// 少了这个头 snapd 的接口直接 400，且报错只说参数错，不提头
const HEADERS = { 'snap-device-series': '16', 'user-agent': UA, accept: 'application/json' };
// 白名单里的字段；带 name 会 400（name 本来就必返）。revision 是能不能省一次请求的关键
const FIELDS = 'title,summary,publisher,version,media,store-url,license,revision';
const PICK = 4;

const FIND_TTL = 10 * 60 * 1000;
const INFO_TTL = 30 * 60 * 1000;
// 失败也要记一小会儿：snapcraft 的边缘节点会间歇性卡住，一次卡完立刻重试还是卡，
// 让用户连点三次搜索就白等三次。
const FAIL_TTL = 60 * 1000;
const MAX_FIND_CACHE = 500;
const MAX_INFO_CACHE = 1000;
const findCache = new Map();
const infoCache = new Map();

function trimCache(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

const ARCH_LABEL = {
  amd64: 'x86_64',
  arm64: 'ARM64',
  armhf: 'ARMhf',
  i386: 'x86',
  riscv64: 'RISC-V',
  ppc64el: 'ppc64el',
  s390x: 's390x',
};

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function cached(map, key, ttl, load) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < (hit.ttl || ttl)) {
    // 失败也在冷却期内原样抛出来：UI 上看到「429」比看到「0 个结果」诚实
    return hit.err ? Promise.reject(hit.err) : Promise.resolve(hit.data);
  }
  return load().then(
    (data) => {
      map.set(key, { at: Date.now(), data, ttl });
      trimCache(map, map === findCache ? MAX_FIND_CACHE : MAX_INFO_CACHE);
      return data;
    },
    (err) => {
      map.set(key, { at: Date.now(), err, ttl: FAIL_TTL });
      trimCache(map, map === findCache ? MAX_FIND_CACHE : MAX_INFO_CACHE);
      throw err;
    }
  );
}

/**
 * 直连 / 代理对冲取数。
 *
 * 这台机器的 DNS 被 TUN 接管，api.snapcraft.io 解析成 198.18.0.155 这种假 IP，
 * 直连的 TLS 握手会随机卡住 5s+（curl 却正常，Node 的握手更容易被掐）；
 * 而走本机代理 7897 稳定 0.8s 回来。所以先发直连，700ms 没回来就同时补发一条
 * 代理请求，谁先回用谁（Promise.any）。直连快的时候不会白打第二条，
 * 代理没开的时候直连那条照样能救场。
 */
function fetchSnapJson(pathname, timeout) {
  const url = `${API}${pathname}`;
  const direct = smartJson(url, {
    timeout,
    headers: HEADERS,
    prefer: 'direct',
    hardPrefer: true,
    noFallback: true,
  });

  let timer;
  const hedged = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      smartJson(url, { timeout, headers: HEADERS, forceProxy: true }).then(resolve, reject);
    }, 700);
    timer.unref?.();
  });

  // req.setTimeout 只管 socket 就绪后的静默，DNS / TCP 卡在握手前它根本不触发
  // （实测直连能卡 10s 才报错）。所以再压一道墙钟死线，保证最坏情况有上界。
  let deadline;
  const bail = new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error('timeout')), timeout);
    deadline.unref?.();
  });

  return Promise.race([Promise.any([direct, hedged]), bail])
    .catch((err) => {
      // AggregateError 的 message 只有一句 "All promises were rejected"，把真实原因拼出来
      const reasons = (err.errors || []).map((e) => e.message).filter(Boolean);
      throw new Error(reasons.join(' / ') || err.message);
    })
    .finally(() => {
      clearTimeout(timer);
      clearTimeout(deadline);
    });
}

async function find(term) {
  return cached(findCache, term.toLowerCase(), FIND_TTL, async () => {
    // 失败会进冷却，所以这里留一次重试，别让一次抖动把整栏锁住
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const t0 = Date.now();
      try {
        const data = await fetchSnapJson(
          `/snaps/find?q=${encodeURIComponent(term)}&fields=${FIELDS}`,
          3000
        );
        if (process.env.SNAP_DEBUG === '1') {
          console.error(`[snap] find ${term} ${Date.now() - t0}ms${attempt ? ' (retry)' : ''}`);
        }
        return data?.results || [];
      } catch (e) {
        lastErr = e;
        if (attempt === 1) throw e;
      }
    }
    throw lastErr;
  });
}

/** 只补架构用的，超时压到 3s 且不回退代理：它挂了就用 find 拼出来的地址顶上 */
async function info(name) {
  return cached(infoCache, name, INFO_TTL, () => {
    const t0 = Date.now();
    return fetchSnapJson(`/snaps/info/${encodeURIComponent(name)}`, 3000).then(
      (d) => {
        if (process.env.SNAP_DEBUG === '1') console.error(`[snap] info ${name} ${Date.now() - t0}ms`);
        return d;
      },
      (e) => {
        if (process.env.SNAP_DEBUG === '1') console.error(`[snap] info ${name} FAIL ${Date.now() - t0}ms ${e.message}`);
        throw e;
      }
    );
  }).catch(() => null);
}

/** find 就够拼出下载地址，不需要 info */
function urlFromFind(h) {
  const rev = h.revision?.revision;
  if (!rev || !h['snap-id']) return '';
  return `${DOWNLOAD}/${h['snap-id']}_${rev}.snap`;
}

/** 给聚合层用的统一 item 结构 */
async function source(term, { relevance } = {}) {
  const hits = await find(term);
  if (!hits.length) return [];

  const ranked = hits
    .map((h) => {
      const title = h.snap?.title || h.name || '';
      const deep = relevance ? Math.max(relevance(title, term), relevance(h.name || '', term)) : 0;
      return { h, title, rel: deep };
    })
    .filter((x) => x.rel > 0)
    .sort((a, b) => b.rel - a.rel)
    .slice(0, PICK);

  const detailed = await Promise.all(
    ranked.map(async (row) => {
      try {
        return { ...row, detail: await info(row.h.name) };
      } catch {
        return { ...row, detail: null };
      }
    })
  );

  return detailed
    .map(({ h, title, rel, detail }) => {
      const snap = detail?.snap || h.snap || {};
      const icon = (snap.media || []).find((m) => m.type === 'icon')?.url || '';

      // info 成功：按 stable 通道、按架构各留一条
      let downloads = [];
      let infoVersion = '';
      if (detail) {
        const channels = (detail['channel-map'] || []).filter(
          (c) => c.channel?.name === 'stable' && c.download?.url
        );
        const byArch = new Map();
        for (const c of channels) {
          const arch = c.channel.architecture || 'amd64';
          const prev = byArch.get(arch);
          if (!prev || Number(c.revision) > Number(prev.revision)) byArch.set(arch, c);
        }
        const picks = [...byArch.entries()].sort((a, b) => {
          // x86_64 放前面，其余按名字稳定排序，避免主按钮每次搜都不一样
          if (a[0] === 'amd64') return -1;
          if (b[0] === 'amd64') return 1;
          return a[0].localeCompare(b[0]);
        });
        downloads = picks.map(([arch, c]) => ({
          label: `${h.name} ${c.version || ''} (${arch})`.trim(),
          short: `Linux · ${ARCH_LABEL[arch] || arch}`,
          url: c.download.url,
          kind: 'direct',
          platform: 'linux',
          size: fmtSize(c.download.size),
          filename: `${h.name}_${c.version || c.revision}_${arch}.snap`,
          origin: 'snapcraft',
          sha3: c.download['sha3-384'] || '',
        }));
        infoVersion = picks[0]?.[1]?.version || '';
      }

      // info 没拿到（429 / 超时）：退回 find 拼出来的地址，宁可少标架构也别整栏空着
      if (!downloads.length) {
        const url = urlFromFind(h);
        if (!url) return null;
        downloads = [
          {
            label: `${h.name} ${h.revision?.version || ''}`.trim(),
            short: 'Linux · snap',
            url,
            kind: 'direct',
            platform: 'linux',
            size: fmtSize(h.revision?.download?.size),
            filename: `${h.name}_${h.revision?.revision}_amd64.snap`,
            origin: 'snapcraft',
          },
        ];
      }

      const version = infoVersion || h.revision?.version || '';

      return {
        id: `snap:${h.name}`,
        name: snap.title || title || h.name,
        publisher: snap.publisher?.['display-name'] || snap.publisher?.username || '',
        version,
        icon,
        summary: snap.summary || '',
        tags: [h.name],
        platforms: ['linux'],
        meta: [
          version ? `v${version}` : '',
          downloads.map((d) => d.short.replace('Linux · ', '')).join(' / '),
          snap.license && snap.license !== 'unset' ? snap.license : '',
        ].filter(Boolean),
        price: '免费',
        updated: '',
        source: 'Snapcraft',
        sourceUrl: snap['store-url'] || `https://snapcraft.io/${h.name}`,
        trust: snap.publisher?.validation === 'verified' ? '发布者已验证' : 'Snap 官方商店',
        rel,
        downloads,
      };
    })
    .filter(Boolean);
}

module.exports = { source, find, info, fmtSize };
