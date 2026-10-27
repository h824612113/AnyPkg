'use strict';

/**
 * Winget（Windows）数据源。
 *
 * 官方没有公开的搜索 API：winget.run 早停更、api.winget.microsoft.com 解析不了。
 * 但客户端自己用的 REST 源（source.msix）是公开的——一个 21MB 的 zip，里面
 * Public/index.db 是 44MB 的 SQLite，装着全部 15k 个包 / 18 万条清单的索引。
 * 把它下到本地查，等于白拿一份可离线的 Windows 应用索引；清单正文再从
 * cdn.winget.microsoft.com/cache/<path> 取，里面 InstallerUrl 就是厂商官网直链。
 *
 * node:sqlite 是 Node 22 才有的实验特性（会打一行 warning），低版本直接降级，
 * 不能因为一个数据源把整个服务拖挂。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const INDEX_URL = 'https://cdn.winget.microsoft.com/cache/source.msix';
const BLOB_BASE = 'https://cdn.winget.microsoft.com/cache/';
const CACHE_DIR = path.join(__dirname, '..', '.cache', 'winget');
const DB_PATH = path.join(CACHE_DIR, 'index.db');
const TTL = 24 * 60 * 60 * 1000; // 微软每天刷一次索引，跟着它的节奏走

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

let db = null;
let indexJob = null;
const blobCache = new Map(); // path -> { at, text }
const BLOB_TTL = 10 * 60 * 1000;
const MAX_BLOB_CACHE = 300;

function trimBlobCache() {
  while (blobCache.size > MAX_BLOB_CACHE) blobCache.delete(blobCache.keys().next().value);
}

/* ------------------------------------------------------------------ */
/* zip：只够从 msix 里掏一个 index.db，不引依赖                          */
/* ------------------------------------------------------------------ */

/** 48MB 的 index.db 会触碰 zip64：0xFFFFFFFF 表示真值在 0x0001 扩展字段里 */
function zip64Values(buf, start, len, needed) {
  let off = start;
  const end = start + len;
  while (off + 4 <= end) {
    const id = buf.readUInt16LE(off);
    const size = buf.readUInt16LE(off + 2);
    if (id === 0x0001) {
      const out = [];
      let p = off + 4;
      for (const key of needed) {
        if (key === 0xffffffff && p + 8 <= off + 4 + size) {
          out.push(Number(buf.readBigUInt64LE(p)));
          p += 8;
        } else {
          out.push(key);
        }
      }
      return out;
    }
    off += 4 + size;
  }
  return needed;
}

function unzipEntry(buf, wanted) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('msix 不是合法 zip');

  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  // zip64 的 EOCD：真值在 locator 指过去的那条记录里
  if (off === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(z64) === 0x06064b50) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        off = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (name === wanted) {
      // 顺序固定：未压缩大小、压缩大小、本地头偏移；只有值为全 F 的才写在扩展字段里
      const [, compSize, localOff] = zip64Values(
        buf,
        off + 46 + nameLen,
        extraLen,
        [buf.readUInt32LE(off + 24), buf.readUInt32LE(off + 20), buf.readUInt32LE(off + 42)]
      );
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`msix 用了不支持的压缩方式 ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`msix 里没有 ${wanted}`);
}

/* ------------------------------------------------------------------ */
/* 索引下载与打开                                                        */
/* ------------------------------------------------------------------ */

function indexReady() {
  try {
    const st = fs.statSync(DB_PATH);
    return Date.now() - st.mtimeMs < TTL;
  } catch {
    return false;
  }
}

async function buildIndex() {
  const { smartOpen } = require('./net');
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const r = await smartOpen(INDEX_URL, { timeout: 120000 });
  if (r.status !== 200) throw new Error(`索引下载失败 HTTP ${r.status}`);

  const chunks = [];
  for await (const c of r.stream) chunks.push(c);
  const buf = Buffer.concat(chunks);

  const dbBuf = unzipEntry(buf, 'Public/index.db');
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, dbBuf);
  fs.renameSync(tmp, DB_PATH);
  return DB_PATH;
}

async function ensureIndex() {
  if (db) return db;
  if (indexJob) return indexJob;

  indexJob = (async () => {
    if (!DatabaseSync) throw new Error('需要 Node 22+ 才有 node:sqlite');
    if (!indexReady()) await buildIndex();
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    return db;
  })().finally(() => {
    indexJob = null;
  });

  return indexJob;
}

/* ------------------------------------------------------------------ */
/* 查询                                                                 */
/* ------------------------------------------------------------------ */

/** pathpart 是链表，一路往上拼才得到 manifests/g/Google/Chrome/1.2.3/abcdef */
function resolvePath(conn, rowid) {
  const parts = [];
  let cur = rowid;
  while (cur) {
    const row = conn.prepare('select parent, pathpart from pathparts where rowid = ?').get(cur);
    if (!row) break;
    parts.push(row.pathpart);
    cur = row.parent;
  }
  return parts.reverse().join('/');
}

async function manifestText(relPath) {
  const hit = blobCache.get(relPath);
  if (hit && Date.now() - hit.at < BLOB_TTL) return hit.text;

  const { smartText } = require('./net');
  const text = await smartText(BLOB_BASE + relPath, { timeout: 15000 });
  blobCache.set(relPath, { at: Date.now(), text });
  trimBlobCache();
  return text;
}

/**
 * 清单是 YAML，但我们只要 Installers 下面那层扁平字段。
 * 为一个数据源引 js-yaml 不值当，手写个小状态机足够——顶格的新键就是块结束。
 */
function parseInstallers(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  let inside = false;
  let cur = null;

  for (const line of lines) {
    if (/^Installers:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (line.trim() && !/^\s/.test(line) && !line.startsWith('- ')) {
      if (cur) out.push(cur);
      cur = null;
      inside = false;
      continue;
    }
    const start = line.match(/^-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (start) {
      if (cur) out.push(cur);
      cur = { [start[1]]: start[2].trim() };
      continue;
    }
    // InstallerSha256 这种键名里带数字，字符类不能只写 [A-Za-z]
    const kv = line.match(/^\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (kv && cur) cur[kv[1]] = kv[2].trim();
  }
  if (cur) out.push(cur);
  return out;
}

function topField(text, key) {
  const m = String(text).match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
}

const ARCH_LABEL = { x64: 'x64', x86: 'x86', arm64: 'ARM64', arm: 'ARM', neutral: '通用' };

function fileNameOf(url) {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return base || 'installer.exe';
  } catch {
    return 'installer.exe';
  }
}

/* ------------------------------------------------------------------ */
/* 对外                                                                 */
/* ------------------------------------------------------------------ */

function available() {
  return Boolean(DatabaseSync);
}

async function source(term, { relevance } = {}) {
  const conn = await ensureIndex();
  const raw = term.trim();
  const within = `%${raw}%`;
  const prefix = `${raw}%`;

  // 排序权重：包名完全相等 > 显示名完全相等 > 包名末端相等（Google.Chrome 之于 chrome）
  // > 前缀 > 任意位置。少了这一层，搜 chrome 会先撞上一串 ChromeDriver。
  const rows = conn
    .prepare(
      `select i.id as id, n.name as name, v.version as version, m.pathpart as pp,
              case
                when lower(i.id) = lower(?) then 0
                when lower(n.name) = lower(?) then 1
                when lower(i.id) like ('%.' || lower(?)) then 2
                when lower(i.id) like lower(?) then 3
                when lower(n.name) like lower(?) then 4
                else 5
              end as rank
         from manifest m
         join ids i on i.rowid = m.id
         join names n on n.rowid = m.name
         join versions v on v.rowid = m.version
        where i.id like ? or n.name like ?
        order by rank asc, length(n.name) asc
        limit 600`
    )
    .all(raw, raw, raw, prefix, prefix, within, within);

  // 同一个包会有几十条清单，只留版本号最大的；rank 取第一次出现的那条（SQL 已排好）
  const best = new Map();
  for (const r of rows) {
    const hit = relevance ? Math.max(relevance(r.name, term), relevance(r.id, term)) : 1;
    if (hit <= 0) continue;
    const prev = best.get(r.id);
    if (!prev) {
      best.set(r.id, { ...r, rel: hit });
    } else if (compareVersion(r.version, prev.version) > 0) {
      best.set(r.id, { ...prev, ...r, rel: Math.max(prev.rel, hit), rank: prev.rank });
    }
  }

  const picked = [...best.values()]
    .sort((a, b) => a.rank - b.rank || b.rel - a.rel)
    .slice(0, 6);

  const items = await Promise.all(
    picked.map(async (r) => {
      let text = '';
      try {
        text = await manifestText(resolvePath(conn, r.pp));
      } catch {
        text = '';
      }

      const installers = text ? parseInstallers(text) : [];
      const downloads = [];
      for (const ins of installers) {
        const url = ins.InstallerUrl || '';
        if (!url || !/^https?:/i.test(url)) continue;
        // msstore 类型只是把商店页面丢过来，不是我们能直下的安装包
        const storeLink = /apps\.microsoft\.com|microsoft\.com\/store/i.test(url);
        const archText = ARCH_LABEL[ins.Architecture] || ins.Architecture || '安装包';
        // 同一个架构常有两三个包（比如 7z 本体和 extra），带上扩展名才分得清
        const ext = (url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i) || [])[1];
        downloads.push({
          label: `${fileNameOf(url)}${ins.InstallerLocale ? `（${ins.InstallerLocale}）` : ''}`,
          short: `Windows · ${archText}${ext ? ` · ${ext.toUpperCase()}` : ''}`,
          url,
          kind: storeLink ? 'link' : 'direct',
          platform: 'windows',
          arch: ins.Architecture || '',
          size: '',
          filename: fileNameOf(url),
          origin: 'winget',
          sha256: ins.InstallerSha256 || '',
        });
      }
      if (!downloads.length) return null;

      // 清单里的顺序是按架构名排的（x86 在前），主按钮应该是 x64
      const ARCH_PREF = { x64: 0, arm64: 1, x86: 2, arm: 3, neutral: 4 };
      downloads.sort((a, b) => (ARCH_PREF[a.arch] ?? 9) - (ARCH_PREF[b.arch] ?? 9));

      const name = r.name && r.name !== r.id ? r.name : r.id.split('.').pop();
      const desc = text ? topField(text, 'Description').slice(0, 180) : '';

      return {
        id: `winget:${r.id}`,
        name,
        rel: r.rel,
        publisher: r.id.split('.')[0],
        icon: '',
        summary: desc,
        tags: [r.id],
        platforms: ['windows'],
        meta: [`v${r.version}`, topField(text, 'InstallerType').toUpperCase() || '安装包', '官方直链'],
        rating: null,
        price: '免费',
        pop: 0,
        updated: '',
        source: 'Winget',
        sourceUrl: `https://github.com/microsoft/winget-pkgs/tree/master/${resolvePath(conn, r.pp).replace(/\/[^/]+$/, '')}`,
        downloads: downloads.slice(0, 3),
      };
    })
  );

  return items.filter(Boolean);
}

/** 只给 /api/health 用，别在搜索路径上调 */
function status() {
  return {
    sqlite: Boolean(DatabaseSync),
    index: indexReady(),
    db: db ? DB_PATH : '',
    size: (() => {
      try {
        return fs.statSync(DB_PATH).size;
      } catch {
        return 0;
      }
    })(),
  };
}

function compareVersion(a, b) {
  const x = String(a).split(/[^0-9]+/).map(Number);
  const y = String(b).split(/[^0-9]+/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

module.exports = { available, source, status, ensureIndex, parseInstallers };
