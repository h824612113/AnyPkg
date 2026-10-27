'use strict';

/**
 * 包名 → 应用名 的小字典，落盘。
 *
 * 为什么需要：下载队列里原来只剩文件名，也就是
 * `com.duckduckgo.mobile.android-52990000-merged.apk`、`com.sanjie.sipor_6759524779_1.1.5.ipa`。
 * 搜的时候是「奶茶人」，下完隔天回来看列表就变成一串包名，用户根本对不上是哪个 App。
 *
 * 为什么要落盘而不是只放内存：队列本身是内存态，重启后靠扫 `.downloads` 重建，
 * 那时候手上只有文件名，没有这张表就只能一路显示包名。
 *
 * 为什么不做在线反查：启动恢复清单是同步动作，等接口会把面板卡住；
 * 而且同一个包反复查也没意义——搜到过就有名字了。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 1200;

let file = '';
let map = new Map();
let timer = null;

function looksLikeId(name, id) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (n === id) return true;
  // 名字本身就是个点分标识符（com.foo.bar）时对用户没信息量，不如不记。
  // 注意别把「1.1.1.1」这类真应用名误杀，所以要求首字符是小写字母
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(n);
}

function flush() {
  timer = null;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map)), 'utf8');
  } catch {
    /* 写不进去只影响下次重启的显示，不该把调用方带崩 */
  }
}

function save() {
  if (timer) return;
  timer = setTimeout(flush, 800);
  // 服务退出时别丢最后一笔
  timer.unref?.();
}

function init(p) {
  file = p;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' && v.trim()) map.set(k, v.trim());
      }
    }
  } catch {
    /* 没有这个文件是常态（第一次跑） */
  }
  return map.size;
}

/** 记一条。同一个包名后到的覆盖先到的——后到的通常来自用户实际点的那张卡片 */
function remember(id, name) {
  const key = String(id || '').trim();
  const val = String(name || '').trim();
  if (!key || !val || looksLikeId(val, key)) return false;
  if (map.get(key) === val) return false;
  map.set(key, val.slice(0, 120));
  // Map 按插入序，超了就从最老的开始丢
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  save();
  return true;
}

function lookup(id) {
  return map.get(String(id || '').trim()) || '';
}

/**
 * 从文件名猜出应用名。恢复历史下载时手上只有文件名：
 *   com.duckduckgo.mobile.android-52990000-merged.apk
 *   com.sanjie.sipor_6759524779_1.1.5.ipa
 * 包名后面一定跟 `-` 或 `_`，所以先按分隔符切，再退化成「已知包名前缀」匹配。
 */
function nameForFile(fileName) {
  const s = String(fileName || '');
  if (!s) return '';
  const hit = s.match(/^([A-Za-z][\w.]*[A-Za-z0-9])(?:[-_].*)?\.[A-Za-z0-9]{1,8}$/);
  if (hit) {
    const got = lookup(hit[1]);
    if (got) return got;
  }
  // 兜底：万一包名里带连字符，用已知键做前缀匹配（上千条也就是一次线性扫）
  for (const [id, name] of map) {
    if (s.startsWith(id) && /^[-_.]/.test(s.slice(id.length))) return name;
  }
  return '';
}

module.exports = { init, remember, lookup, nameForFile, flush };
