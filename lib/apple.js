'use strict';

/**
 * ipatool 的 Node 侧封装：登录 / 版本列表 / 下载。
 *
 * 为什么不走 ipatool 的交互模式：
 *   - 交互模式下进度条往 stdout 打 ANSI 控制符，解析比读 JSON 脆得多；
 *   - 非交互模式下 2FA 的行为恰好是「打印一句提示、退出码 0、什么都不存」，
 *     所以前端拿到「需要 2FA」后再跑一次带 --auth-code 的命令即可——
 *     这正是 ipatool 自己在交互模式下 retry 时做的事（重新走一遍完整登录）。
 *
 * 还有两个必须处理的坑：
 *   - ipatool 是 Go 写的，走 ProxyFromEnvironment。本机 fpinit.itunes.apple.com
 *     直连不通（EOF），必须显式给大写 HTTPS_PROXY；宿主环境里的小写 https_proxy
 *     指向一个连不通 Apple 的内部代理，两套都得覆盖。
 *   - 下载中途没有结构化进度，但它先写 `<目标>.tmp` 再改名，所以轮询临时文件
 *     大小就是最可靠的进度来源。
 */

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { detectProxy, smartJson } = require('./net');

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');

/** 与 ipatool 的 --platform 取值一一对应；前三个是实际会用到的 */
const PLATFORMS = ['iphone', 'ipad', 'macos', 'appletv', 'watchos', 'visionos'];

// get-version-metadata 单次要 20~25 秒（ipatool 自己内部的重试，跟代理无关，直连也一样），
// 所以必须并发；但 ipatool 用 O_EXCL 建 cookies.lock，同一瞬间起两个进程会撞锁，
// 因此并发 4 + 启动错开 250ms（见 launchSlot）。
const CONCURRENCY = 4;
const MAX_VERSIONS = 20;     // 默认补最近 20 个版本的详情
const HARD_MAX_VERSIONS = 60; // 前端最多能要这么多，再多就是几十次进程往返
const VERSION_TTL = 10 * 60 * 1000;
const MAX_ID_CACHE = 500;
const MAX_META_CACHE = 1000;
const DOWNLOAD_TIMEOUT = 30 * 60 * 1000;
// 两次 IPA 下载之间的冷却间隔。ipatool 是「非官方客户端」，短时间内连续多次
// 下载/领许可会把账号打成 disabled——2026-10-22 实测：同一个账号昨天还能正常下，
// 今天所有下载都在「协商包体」这一步返回 account is disabled，且 /api/apple/status
// 仍显示 authed:true（本地 token 没失效，是 Apple 侧的账号状态）。
// 默认 60s，APPLE_COOLDOWN_MS=0 可关掉（批量下历史版本时想加速就关）。
const DOWNLOAD_COOLDOWN = Math.max(0, Number(process.env.APPLE_COOLDOWN_MS) || 60 * 1000);
// 上一次下载尝试结束的时间戳（成功失败都算——失败也同样打了 Apple 的服务器）
let lastDownloadEndAt = 0;

let binCache;
let busy = false;
// 排队等着下载的请求。ipatool 抢 keychain 和 sinf，并发跑会互相踩，
// 所以只能串行；但用户连点几个的时候，拒绝第二个还不如让它们排队。
const waiters = [];
// 当前在跑的 ipatool 子进程，取消时用
let currentChild = null;
let cancelRequested = false;

/** 拿下载槽。返回时槽位已经归调用方，必须配 releaseSlot() */
function acquireSlot() {
  if (!busy) {
    busy = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  const next = waiters.shift();
  // 直接把槽位交给队首，中间不置 false——否则新来的请求会插到排队的人前面
  if (next) next();
  else busy = false;
}

function queueDepth() {
  return waiters.length;
}

/** 中止当前下载（用户在队列面板点取消时用） */
function cancelCurrent() {
  if (!currentChild) return false;
  cancelRequested = true;
  try {
    currentChild.kill('SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * ipatool 每次写 cookie 用的是文件锁。进程被强杀（我们的 30 分钟超时、Ctrl-C、
 * 系统休眠后 socket 断掉、或者用户 Ctrl-Z 掉一个前台 ipatool）会留下一个没人释放的锁，
 * 之后任何请求都只回一句 "failed to save cookies: file locked for too long"——
 * 重试、重登都没用，用户只能自己去删 ~/.ipatool/cookies.lock，很难想到。
 *
 * 这里不能按「文件多旧」判断：锁是刚创建的，mtime 永远是新的，按时间判断等于永不清理
 * （实测就是这样，第一次实现带 15s 门槛，一次都没触发）。
 * 所以只在「ipatool 明确报锁冲突」时调用，而且只删一次、只重试一次：
 *   - 死锁（进程已死）：删掉即恢复；
 *   - 真的有人在另一个终端跑 ipatool：极罕见，最多让那次写入失败，重新登录即可恢复。
 */
const IPATOOL_DIR = path.join(os.homedir(), '.ipatool');
const COOKIE_LOCK = path.join(IPATOOL_DIR, 'cookies.lock');

async function dropStaleLock() {
  try {
    await fsp.rm(COOKIE_LOCK, { force: true });
    return true;
  } catch {
    return false;
  }
}
// 版本 id 列表是「一次调用全给」，元数据才是「一个 id 一次往返」，
// 所以拆成两层缓存：换 limit 不用重查 id，换应用也不用重查已经查过的版本。
const idCache = new Map();
const metaCache = new Map();

function trimCache(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

/* ------------------------------------------------------------------ */
/* 进程与日志                                                          */
/* ------------------------------------------------------------------ */

/** ipatool 的环境：补 PATH，并强制把代理写进大小写两套变量 */
async function toolEnv() {
  const env = { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ''}` };
  const proxy = await detectProxy();
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    // requests/Go/curl 各读各的，两套都写死，别让宿主的内部代理钻空子
    env.http_proxy = proxy;
    env.https_proxy = proxy;
    env.NO_PROXY = '127.0.0.1,localhost,::1';
    env.no_proxy = env.NO_PROXY;
    delete env.ALL_PROXY;
    delete env.all_proxy;
  }
  return env;
}

async function resolveBin() {
  if (binCache !== undefined) return binCache;
  for (const p of ['/opt/homebrew/bin/ipatool', '/usr/local/bin/ipatool']) {
    if (fs.existsSync(p)) return (binCache = p);
  }
  binCache = await new Promise((resolve) => {
    execFile('which', ['ipatool'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim().split('\n')[0] || '');
    });
  });
  return binCache;
}

function run(bin, args, { timeout = 60000 } = {}) {
  return toolEnv().then(
    (env) =>
      new Promise((resolve) => {
        execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            message: err ? String(err.message || err) : '',
          });
        });
      })
  );
}

/** ipatool 用 zerolog 往 stderr 打行式 JSON，stdout 一并扫，顺序不保证但只关心最后一条 */
function parseEvents(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 半行或非 JSON 日志，跳过 */
    }
  }
  return out;
}

function lastEvent(r) {
  const ev = parseEvents(`${r.stdout}\n${r.stderr}`);
  return ev.length ? ev[ev.length - 1] : {};
}

function hasSuccess(r) {
  return parseEvents(`${r.stdout}\n${r.stderr}`).some((e) => e.success === true);
}

/** 失败原因：优先取 JSON 事件里的 error，没有就退回原始输出的第一行（panic 场景） */
function rawFailure(r) {
  const ev = lastEvent(r);
  const text = String(ev.error || ev.message || '');
  if (text) return text;
  return (
    String(r.stderr || r.stdout || r.message || '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) || ''
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一次 ipatool，碰到 cookie 锁残留就清掉重试一次。
 *
 * 为什么所有命令都要过这一层：ipatool 用 O_EXCL 建 cookies.lock 当锁，
 * 进程被强杀（下载超时、Ctrl-C、系统休眠）留下文件后，**之后每一条命令**都会
 * panic 在 "cannot load cookies: file locked for too long"，包括 auth info。
 */
async function runWithRetry(bin, args, opts) {
  const r = await run(bin, args, opts);
  if (hasSuccess(r)) return r;
  if (!/lock|cannot acquire/i.test(`${rawFailure(r)} ${r.message || ''}`)) return r;
  if (!(await dropStaleLock())) return r;
  await sleep(300);
  return run(bin, args, opts);
}

/** 把 ipatool 的英文报错翻成能指导下一步动作的中文 */
function humanError(msg) {
  const m = String(msg || '');
  if (/2FA code is required/i.test(m)) return { needs2fa: true, message: 'Apple 要求两步验证，验证码已发到你信任的设备' };
  if (/must contain exactly six digits|two-factor|verification code/i.test(m)) {
    return { badCode: true, message: '验证码不对，重新输入六位数字' };
  }
  if (/failed to get account|could not be found in the keyring/i.test(m)) {
    return { code: 'auth', needsAuth: true, message: '还没登录 Apple ID，先点页面顶部的「连接账号」' };
  }
  if (/invalid password|incorrect|account is disabled|account is locked/i.test(m)) {
    return { code: 'auth', message: 'Apple ID 或密码不对（Apple 不会告诉具体是哪一项）' };
  }
  if (/license required|subscription required|not purchased/i.test(m)) {
    return {
      code: 'paid_app',
      message: '这个应用你还没“获取”过，而且是付费的。先在 iPhone 的 App Store 里买一次，之后就能下。',
    };
  }
  if (/not available in the storefront|not found/i.test(m)) {
    // 带上 code：队列面板靠它判断「重试」按钮该不该出现，
    // 区域不提供这种错点十次也是同一句话
    return { code: 'not_found', message: '这个应用在你账号所在的国家/地区商店没有上架' };
  }
  if (/timeout|EOF|no such host|connection refused|TLS handshake|proxyconnect|failed to download file|connection reset|broken pipe/i.test(m)) {
    // 域名要留着：iosapps.itunes.apple.com 和 itunes.apple.com 是两个 CDN，
    // 只有前者要走代理。截断到 80 字符就只剩「Get "https://iosapps.it」，
    // 用户完全不知道自己卡在哪一步。
    const host = (m.match(/https?:\/\/([^/"'\s]+)/) || [])[1] || '';
    return {
      code: 'network',
      network: true,
      message: `连不上 Apple${host ? `（${host}）` : ''}：网络中断。已经自动重试两次（共三次都没成）——检查代理是否在跑，或者换个节点；ipatool 不支持断点续传，只能从头再来。`,
    };
  }
  if (/password token expired/i.test(m)) {
    return { code: 'auth', message: '登录状态过期了，退出后重新登录一次' };
  }
  // ipatool 用文件锁保护 cookie，被强杀后会留下死锁，之后每次请求都只回这一句
  if (/locked for too long|cannot acquire lock/i.test(m)) {
    return { message: 'ipatool 的 cookie 锁没释放（上次被强行中断留下的），会自动清掉重试一次；还不行就删 ~/.ipatool/cookies.lock' };
  }
  // 老版本号对不上：Apple 只对「当前可售」的版本返回元数据，很久以前的版本会这样
  if (/update response does not match the requested app or version/i.test(m)) {
    return { message: '这个版本号 Apple 已经不返回了（常见于很早的历史版本），换一个版本试' };
  }
  if (/^app not found$|not found in the storefront/i.test(m)) {
    return { code: 'not_found', message: '这个应用在你账号所在的国家/地区商店没有上架' };
  }
  return { message: m || 'ipatool 没有返回原因' };
}

/* ------------------------------------------------------------------ */
/* 账号                                                               */
/* ------------------------------------------------------------------ */

async function status() {
  const bin = await resolveBin();
  if (!bin) return { available: false, authed: false, email: '', name: '', path: '' };

  const r = await runWithRetry(bin, ['auth', 'info', '--non-interactive', '--format', 'json'], { timeout: 20000 });
  const ev = lastEvent(r);
  const authed = Boolean(ev.success);
  return {
    available: true,
    path: bin,
    authed,
    email: authed ? ev.email || '' : '',
    name: authed ? ev.name || '' : '',
    // 未登录时把原因留在外层，方便前端区分「没登录」和「登录态失效」
    error: authed ? '' : String(ev.error || '').slice(0, 200),
  };
}

async function login({ email, password, code }) {
  const bin = await resolveBin();
  if (!bin) return { ok: false, message: '本机没装 ipatool，先运行 brew install ipatool' };

  const id = String(email || '').trim();
  const pwd = String(password || '');
  if (!id) return { ok: false, message: 'Apple ID 不能为空' };
  if (!pwd) return { ok: false, message: '密码不能为空' };

  const authCode = String(code || '').trim();
  if (authCode && !/^\d{6}$/.test(authCode)) return { ok: false, badCode: true, message: '验证码是 6 位数字' };

  const args = ['auth', 'login', '--email', id, '--password', pwd, '--non-interactive', '--format', 'json'];
  if (authCode) args.push('--auth-code', authCode);

  // 首次登录要 Apple 下发 SAP 配置并建立会话，给足时间
  const r = await runWithRetry(bin, args, { timeout: 180000 });

  if (hasSuccess(r)) {
    const ev = parseEvents(`${r.stdout}\n${r.stderr}`).filter((e) => e.success === true).pop() || {};
    return { ok: true, email: ev.email || id, name: ev.name || '' };
  }

  const ev = lastEvent(r);
  const hint = humanError(ev.error || ev.message || r.message);
  // needs2fa 是正常路径，不是失败：前端接着要验证码
  return { ok: false, ...hint, log: String(ev.error || ev.message || '').slice(0, 300) };
}

async function logout() {
  const bin = await resolveBin();
  if (!bin) return { ok: false, message: '没装 ipatool' };
  const r = await runWithRetry(bin, ['auth', 'revoke', '--format', 'json', '--non-interactive'], { timeout: 30000 });
  return { ok: hasSuccess(r), message: hasSuccess(r) ? '' : humanError(lastEvent(r).error).message };
}

/* ------------------------------------------------------------------ */
/* 版本                                                               */
/* ------------------------------------------------------------------ */

async function pool(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * 让「起进程」这个动作错开 250ms。
 *
 * ipatool 的锁是 `open(cookies.lock, O_EXCL)`，进程一启动就建、退出才删。
 * 四个进程同一毫秒起来，后三个必然撞上 "file exists" 然后 panic。
 * 这里只错开启动时刻，不串行化整个请求——每个请求本身还要 20 多秒，
 * 串起来就等于把并发废掉了。
 */
let nextLaunch = 0;
async function launchSlot() {
  const now = Date.now();
  const at = Math.max(now, nextLaunch);
  nextLaunch = at + 250;
  if (at > now) await sleep(at - now);
}

/**
 * 列历史版本。list-versions 只给一串 externalVersionId（纯数字，没法看），
 * 想让用户选「8.0.5」这种可读音的版本号，只能对每个 id 再查一次元数据。
 * 所以这里做成流式：每查到一个推一条，前端边收边渲染。
 *
 * 和 ipatool-py 的 historyver 一样：id 列表是免费的，一次调用全拿到，
 * 所以先报 total，再按 limit 只补最近的一段——用户想看更多就再要一次。
 */
async function versionIds(bin, bundleId, platform) {
  const key = `${bundleId}:${platform}`;
  const hit = idCache.get(key);
  if (hit && Date.now() - hit.at < VERSION_TTL) return hit.ids;

  const r = await runWithRetry(
    bin,
    ['list-versions', '-b', bundleId, '--platform', platform, '--format', 'json', '--non-interactive'],
    { timeout: 60000 }
  );
  if (!hasSuccess(r)) {
    const err = new Error('list-versions failed');
    err.hint = humanError(lastEvent(r).error || lastEvent(r).message);
    throw err;
  }

  const ids = (lastEvent(r).externalVersionIdentifiers || []).map(String);
  idCache.set(key, { at: Date.now(), ids });
  trimCache(idCache, MAX_ID_CACHE);
  return ids;
}

async function metaFor(bin, bundleId, platform, id) {
  const key = `${bundleId}:${platform}:${id}`;
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < VERSION_TTL) return hit.value;

  await launchSlot();
  const mr = await runWithRetry(
    bin,
    [
      'get-version-metadata',
      '-b',
      bundleId,
      '--external-version-id',
      id,
      '--platform',
      platform,
      '--format',
      'json',
      '--non-interactive',
    ],
    { timeout: 45000 }
  );
  if (!hasSuccess(mr)) return null;

  const ev = lastEvent(mr);
  const value = {
    id,
    version: ev.displayVersion || '',
    date: (ev.releaseDate || '').slice(0, 10),
  };
  metaCache.set(key, { at: Date.now(), value });
  trimCache(metaCache, MAX_META_CACHE);
  return value;
}

async function versions(bundleId, platform, onEvent, { limit } = {}) {
  const bin = await resolveBin();
  if (!bin) {
    onEvent({ type: 'error', message: '本机没装 ipatool' });
    return;
  }

  const cap = Math.min(Math.max(Number(limit) || MAX_VERSIONS, 1), HARD_MAX_VERSIONS);

  let ids;
  try {
    ids = await versionIds(bin, bundleId, platform);
  } catch (e) {
    onEvent({ type: 'error', ...(e.hint || { message: String(e.message || e) }) });
    return;
  }

  if (!ids.length) {
    onEvent({ type: 'done', count: 0, total: 0 });
    return;
  }

  // 先告诉前端「一共有多少个」，用户才知道自己看的是一段还是全部
  onEvent({ type: 'total', total: ids.length, showing: Math.min(cap, ids.length) });

  // list-versions 给的是**从旧到新**的升序（3328911 → 891813653）。
  // 早先直接 slice(0, cap)，拿到的其实是最古老的几十个版本：那些版本 Apple 大多
  // 已经不返回元数据（"info plist does not contain a display version"），
  // 于是界面上「历史版本」永远是空的。先反转，才是用户要的「最近 N 个」。
  const newestFirst = ids.slice().reverse();
  const picked = newestFirst.slice(0, cap);
  const found = [];

  await pool(picked, CONCURRENCY, async (id) => {
    const item = await metaFor(bin, bundleId, platform, id);
    if (!item) return;
    found.push(item);
    onEvent({ type: 'version', ...item });
  });

  // 并发跑完后按 picked 的顺序排一遍，保证「新 → 旧」。
  // 前端是边收边渲染的，收到的顺序是并发完成的顺序，所以 done 里再给一份排好的。
  const ordered = picked.map((id) => found.find((f) => f.id === id)).filter(Boolean);
  onEvent({ type: 'done', count: ordered.length, total: ids.length, showing: picked.length, versions: ordered });
}

/* ------------------------------------------------------------------ */
/* 下载                                                               */
/* ------------------------------------------------------------------ */

function fmtSize(n) {
  if (!n) return '0 B';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** 下载中会先出现 `<名字>.tmp`，找到它就能报进度 */
async function tmpProgress(dir, before) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!name.endsWith('.tmp') || before.has(name)) continue;
    try {
      total += (await fsp.stat(path.join(dir, name))).size;
    } catch {
      /* 正在改名，忽略 */
    }
  }
  return total;
}

/** 清掉这次下载留下的残包；重试前也要清，否则上次的半截文件会被算进进度 */
async function clearTmp(dir, before) {
  try {
    for (const name of await fsp.readdir(dir)) {
      if (name.endsWith('.tmp') && !before.has(name)) {
        await fsp.rm(path.join(dir, name), { force: true });
      }
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/**
 * App Store 报的安装体积，只用来当进度条的分母。
 *
 * 为什么需要它：ipatool 只会闷头写 `.tmp`，从不告诉你总共多大，界面就只能显示
 * 「已下载 32 MB」——用户看着一条永远走不完的条，不知道还剩多少。
 *
 * 局限：lookup 返回的永远是「当前版本」的体积，下历史版本时分母会偏大或偏小。
 * 所以前端拿到的是近似值，显示时标「约」，超过分母就停在 99% 别跳。
 */
async function lookupSize(bundleId) {
  try {
    const data = await smartJson(
      `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=cn`,
      { timeout: 8000 }
    );
    const hit = (data?.results || [])[0];
    const n = Number(hit?.fileSizeBytes) || 0;
    return n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/* ---------------- 真实包体大小（进度条分母） ---------------- */

/**
 * lookup 的 fileSizeBytes 是「装好之后占多少」，不是 IPA 的下载体积。
 * 实测 Acloset 6.41.2：报 121.7 MB，实际 IPA 只有 71.6 MB（zip 是压缩的），
 * 拿它当分母，条最多走到 59% 就再也不动，看着像卡死。
 *
 * 所以真下完一次就把实际体积记下来，同一个包下次的进度就是准的。
 * 第一次仍然只能估算（前端标「约」），但至少不会越来越离谱。
 */
const SIZE_FILE = path.join(__dirname, '..', '.cache', 'ipa-size.json');
let sizeCache = null;

function loadSizes() {
  if (!sizeCache) {
    try {
      sizeCache = JSON.parse(fs.readFileSync(SIZE_FILE, 'utf8')) || {};
    } catch {
      sizeCache = {};
    }
  }
  return sizeCache;
}

/** 已知的实际体积：先看这个版本，没有就退到「这个包最近一次下成功的」 */
function knownSize(bundleId, versionId) {
  const c = loadSizes();
  return (
    Number(c[`${bundleId}@${versionId || 'latest'}`]) || Number(c[`${bundleId}@latest`]) || 0
  );
}

function rememberSize(bundleId, versionId, size) {
  if (!bundleId || !size) return;
  const c = loadSizes();
  c[`${bundleId}@${versionId || 'latest'}`] = size;
  // 「latest」这一格只在这次下的真是最新版时才更新，否则会拿老版本的体积去配新版
  if (!versionId) c[`${bundleId}@latest`] = size;
  try {
    fs.mkdirSync(path.dirname(SIZE_FILE), { recursive: true });
    fs.writeFileSync(SIZE_FILE, JSON.stringify(c));
  } catch {
    /* 写不进去只是进度条不准，不该影响下载 */
  }
}

/** 下载目录里已经躺着一份这个包的话，它的体积也比 App Store 的估算值靠谱 */
async function sizeFromExisting(dir, bundleId) {
  try {
    let best = 0;
    for (const n of await fsp.readdir(dir)) {
      if (!n.startsWith(`${bundleId}_`) || !n.endsWith('.ipa')) continue;
      const st = await fsp.stat(path.join(dir, n));
      if (st.size > best) best = st.size;
    }
    return best;
  } catch {
    return 0;
  }
}

/**
 * 下载一个包到 dir。done 时返回 ipatool 给出的真实文件名。
 * 同一时刻只允许一个：并发跑会抢 keychain 和 sinf，出错信息还很难懂。
 */
async function download({ bundleId, platform, versionId, dir, onEvent, shouldAbort }) {
  const bin = await resolveBin();
  if (!bin) return { ok: false, message: '本机没装 ipatool，先运行 brew install ipatool' };

  // 有人在跑就排队，别直接拒。ipatool 不能并发，但等待是便宜且可解释的
  if (busy) {
    const ahead = queueDepth() + 1;
    onEvent?.({
      type: 'progress',
      message: `前面还有 ${ahead} 个 Apple 下载在跑，已排队，轮到会自动开始…`,
      queued: ahead,
    });
  } else {
    onEvent?.({ type: 'progress', message: '开始准备下载…' });
  }
  await acquireSlot();
  // 排队期间用户可能已经在面板上点了取消：这时候轮到它了就别真下
  if (shouldAbort?.()) {
    releaseSlot();
    return { ok: false, canceled: true, message: '已取消' };
  }
  cancelRequested = false;

  // 冷却：距上次下载结束不足 DOWNLOAD_COOLDOWN 就等到够。排队等槽的时间
  // 同样在走，所以按「上次结束到现在」算剩余，不把排队时间重复计一遍。
  // 期间每秒看一眼取消标志——用户点了取消不该还得干等一整轮冷却。
  if (DOWNLOAD_COOLDOWN > 0 && lastDownloadEndAt) {
    const waitMs = lastDownloadEndAt + DOWNLOAD_COOLDOWN - Date.now();
    if (waitMs > 0) {
      onEvent?.({
        type: 'progress',
        message: `账号冷却中，${Math.ceil(waitMs / 1000)} 秒后自动开始（防 Apple 风控，APPLE_COOLDOWN_MS 可调）…`,
        cooldown: Math.ceil(waitMs / 1000),
      });
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (shouldAbort?.()) {
          releaseSlot();
          return { ok: false, canceled: true, message: '已取消' };
        }
        await new Promise((r) => setTimeout(r, Math.min(1000, deadline - Date.now())));
      }
    }
  }

  // 拿到槽位之后、进入下面的主 try 之前，还有建目录/读清单/读环境几步。
  // 这几步一旦抛出去，槽位就永远不还，后续下载会全部卡死在排队里，
  // 所以统一在这里兜住，失败就还槽并当成普通错误返回。
  const plat = PLATFORMS.includes(platform) ? platform : 'iphone';
  let before;
  let env;
  try {
    await fsp.mkdir(dir, { recursive: true });
    before = new Set(await fsp.readdir(dir));
    env = await toolEnv();
  } catch (e) {
    releaseSlot();
    return { ok: false, message: `准备下载目录失败：${String(e.message || e)}` };
  }

  // -o 传目录：让 ipatool 自己拼 `<bundleId>_<appId>_<version>.ipa`，文件名比我们猜的准
  const args = [
    'download',
    '-b',
    bundleId,
    '--platform',
    plat,
    '--purchase', // 免费应用没“获取”过时自动领许可，省一次失败往返
    '--non-interactive',
    '--format',
    'json',
    '-o',
    dir,
  ];
  if (versionId) args.push('--external-version-id', String(versionId));

  // 下载 CDN（iosapps.itunes.apple.com）直连不通，没代理就注定失败。
  // 提前说清楚，别让用户等半分钟才看到一个连接错误。
  if (!env.HTTPS_PROXY) {
    onEvent({ type: 'progress', message: '没检测到本机代理，将直连 Apple（下载 CDN 通常连不上）…' });
  }

  // 先问一次体积：失败就当没有，前端退化成「已下载 X MB · Y MB/s」也还能看。
  // 本地记过这个包的真实体积就用它（准），否则退回 App Store 给的估算值（偏大）。
  let totalBytes = 0;
  try {
    onEvent({ type: 'progress', message: '正在查包体大小…' });
    // 优先级：记过的真实体积 → 目录里已有的同包 → App Store 的估算（偏大）
    totalBytes = knownSize(bundleId, versionId) || (await sizeFromExisting(dir, bundleId));
    const exact = totalBytes > 0;
    if (!exact) totalBytes = await lookupSize(bundleId);
    onEvent({
      type: 'start',
      total: totalBytes,
      totalText: totalBytes ? fmtSize(totalBytes) : '',
      exact,
    });
  } catch {
    /* 查不到就按没有处理 */
  }

  try {
    const attempt = async () => {
      const child = spawn(bin, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      currentChild = child;
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => {
        out += c;
      });
      child.stderr.on('data', (c) => {
        err += c;
      });

      const started = Date.now();
      let lastBytes = 0;
      let noticeAt = 0;
      // 速度用最近几次采样的窗口算，别拿两次瞬时值——900ms 的抖动会让数字乱跳
      const samples = [];
      const timer = setInterval(async () => {
        const bytes = await tmpProgress(dir, before);
        if (bytes && bytes !== lastBytes) {
          lastBytes = bytes;
          const now = Date.now();
          samples.push({ t: now, b: bytes });
          while (samples.length > 6) samples.shift();
          let speed = 0;
          if (samples.length >= 2) {
            const first = samples[0];
            const last = samples[samples.length - 1];
            const dt = (last.t - first.t) / 1000;
            if (dt >= 1) speed = Math.max(0, (last.b - first.b) / dt);
          }
          onEvent({
            type: 'progress',
            bytes,
            total: totalBytes,
            speed,
            message: `已下载 ${fmtSize(bytes)}${totalBytes ? ' / ' + fmtSize(totalBytes) : ''}`,
          });
        } else if (!bytes && child.exitCode === null && Date.now() - started > 4000) {
          // 下载结束的瞬间 `.tmp` 会被改名成 `.ipa`，这时 bytes 归零——
          // 不判断子进程是否还活着，就会在「已完成」之后补一句「正在协商」，
          // 看着像又回到起点了。25 秒才重复一次，中间那段时间交给进度条。
          const now = Date.now();
          if (now - noticeAt > 25000) {
            noticeAt = now;
            onEvent({ type: 'progress', message: '正在和 App Store 协商包体…' });
          }
        }
      }, 900);

      const result = await new Promise((resolve) => {
        const to = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ code: 1, timedOut: true });
        }, DOWNLOAD_TIMEOUT);

        child.on('error', (e) => {
          clearTimeout(to);
          resolve({ code: 1, spawnError: String(e.message || e) });
        });
        child.on('close', (code) => {
          clearTimeout(to);
          resolve({ code: code ?? 1 });
        });
      });

      clearInterval(timer);
      currentChild = null;

      const all = { stdout: out, stderr: err, message: '' };
      if (result.timedOut) return { ok: false, message: '下载超过 30 分钟，已中止' };
      if (result.spawnError) return { ok: false, message: `起不来 ipatool：${result.spawnError}` };
      // 被 cancelCurrent() 杀掉的进程没有任何输出，不单独判一下会变成
      // 一句莫名其妙的「ipatool 没有返回原因」
      if (cancelRequested) return { ok: false, canceled: true, message: '已取消' };

      if (hasSuccess(all)) {
        const ev = parseEvents(`${out}\n${err}`).filter((e) => e.success === true).pop() || {};
        const file = path.basename(ev.output || '');
        const full = path.join(dir, file);
        let size = 0;
        try {
          size = (await fsp.stat(full)).size;
        } catch {
          /* 拿不到大小就先报 0 */
        }
        // 记下真实体积，下次同一个包的进度条分母就是准的
        rememberSize(bundleId, versionId, size);
        return {
          ok: Boolean(file),
          file,
          size,
          sizeText: fmtSize(size),
          purchased: Boolean(ev.purchased),
          message: file ? '' : 'ipatool 说成功但没给文件名',
        };
      }

      const e = lastEvent(all);
      // ipatool 在「拿不到 cookie 锁」这类错误上是直接 panic 的：stderr 只有一大段
      // Go 调用栈、一行 JSON 都没有。只取 JSON 事件的话，用户看到的永远是
      // 「ipatool 没有返回原因」——所以这里退回原始输出的第一行。
      const raw = String(err || out || '').trim();
      const firstLine = raw.split('\n').map((l) => l.trim()).find(Boolean) || '';
      const reason = e.error || e.message || firstLine.replace(/^panic:\s*/i, '');
      return {
        ok: false,
        ...humanError(reason),
        log: String(reason).slice(0, 400),
      };
    };

    let out = await attempt();

    // 下载 CDN（iosapps.itunes.apple.com）走代理时偶发断连，尤其是在几百 KB/s 的
    // 长连接上。只重试一次、重试间隔 2 秒往往还是撞在同一段坏网络上；
    // 这里重试两次、退避 2s → 5s，总共三次机会。
    //
    // ipatool 没有断点续传（2.7 的 download 没有 --resume，也不吐下载直链），
    // 所以每次重试都是从头下——好在它比用户手动重来快，用户不用守着。
    // 只在明确的网络错误上重试：「没买过这个应用」这种确定性失败重跑没用。
    for (let round = 1; !out.ok && out.network && round <= 2; round += 1) {
      const wait = round === 1 ? 2000 : 5000;
      onEvent({
        type: 'progress',
        message: `网络断了，${wait / 1000} 秒后自动重试（第 ${round + 1}/3 次，ipatool 只能从头下）…`,
      });
      await new Promise((r) => setTimeout(r, wait));
      await clearTmp(dir, before);
      out = await attempt();
    }

    // 死锁恢复：清掉没人持有的 cookies.lock 再跑一次。
    // 批量下多个版本时这一步尤其重要——一次卡死会让后面每个版本都跟着失败。
    if (!out.ok && /lock|cookies/i.test(`${out.message || ''} ${out.log || ''}`)) {
      if (await dropStaleLock()) {
        onEvent({ type: 'progress', message: 'ipatool 的 cookie 锁没释放，已清理，重试…' });
        // 给内核一点时间回收上一个进程的 fd，否则新进程可能又看到「已被锁」
        await new Promise((r) => setTimeout(r, 400));
        out = await attempt();
      }
    }
    return out;
  } finally {
    // 先清残包再放槽：反过来的话，下一个下载刚起的 .tmp 会被这次 clearTmp 当成
    // 「本次残留」删掉，症状是下到一半文件突然消失
    await clearTmp(dir, before).catch(() => {});
    // 记下结束时间供冷却用。放在这里而不是成功分支：失败的尝试同样打了
    // Apple 的服务器（协商包体、领许可都是真实请求），风控不区分成败
    lastDownloadEndAt = Date.now();
    releaseSlot();
  }
}

function isBusy() {
  return busy;
}

/* ------------------------------------------------------------------ */
/* 第三方分发页：从 itms-services / 直链里取 IPA                        */
/* ------------------------------------------------------------------ */

/**
 * 企业签名、TestFlight 之外的「自建分发页」几乎都用同一套机制：
 *   <a href="itms-services://?action=download-manifest&url=https%3A%2F%2F...plist">
 * 那个 plist 里就是真正的 .ipa 地址和包信息。
 *
 * 这一步和 ipatool 无关：不需要 Apple ID、不碰 App Store，
 * 只是把页面里的公开链接解析出来，所以页面上照样能给出体积和包名。
 * 注意它只能拿到「别人已经公开分发」的包，不解决 App Store 加密包的问题。
 */
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** manifest 是固定结构的 plist，只取需要的几个 key，不引 XML 解析器 */
function parseManifest(xml) {
  const text = String(xml || '');
  const grab = (key) => {
    const m = text.match(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`));
    return m ? decodeXml(m[1]) : '';
  };

  // assets 里除了软件包还有图标条目，都带 <key>url</key>，
  // 所以先定位 kind=software-package 那一小段再取 url
  let ipaUrl = '';
  const sw = text.indexOf('software-package');
  if (sw >= 0) {
    const seg = text.slice(sw, sw + 4000);
    const m = seg.match(/<key>\s*url\s*<\/key>\s*<string>([\s\S]*?)<\/string>/);
    if (m) ipaUrl = decodeXml(m[1]);
  }
  if (!ipaUrl) ipaUrl = text.match(/https?:\/\/[^<\s"'()]+\.ipa(?:\?[^<\s"'()]*)?/i)?.[0] || '';

  return {
    title: grab('title'),
    bundleId: grab('bundle-identifier'),
    version: grab('bundle-version'),
    ipaUrl,
  };
}

/** 从任意 HTML / JS 里抠出 manifest 与 .ipa 直链 */
function extractTargets(text, pageUrl) {
  const body = String(text).replace(/&amp;/g, '&');
  const manifests = [];
  const ipas = [];
  const seenM = new Set();
  const seenI = new Set();

  for (const m of body.matchAll(/itms-services:\/\/[^"'\s<>\\]+/gi)) {
    const raw = m[0].replace(/&amp;/g, '&');
    let inner = '';
    try {
      inner = new URL(raw).searchParams.get('url') || '';
    } catch {
      /* 不是合法 URL，跳过 */
    }
    if (!inner) continue;
    try {
      // 有的页面把 url 参数再套一层百分号编码
      inner = /^https?%3A/i.test(inner) ? decodeURIComponent(inner) : inner;
      const abs = new URL(inner, pageUrl).toString();
      if (!/^https?:/i.test(abs) || seenM.has(abs)) continue;
      seenM.add(abs);
      manifests.push(abs);
    } catch {
      /* 坏链接 */
    }
  }

  for (const m of body.matchAll(/https?:\/\/[^"'\s<>()\\]+\.ipa(?:\?[^"'\s<>()\\]*)?/gi)) {
    const abs = m[0];
    if (seenI.has(abs)) continue;
    seenI.add(abs);
    ipas.push(abs);
  }

  return { manifests: manifests.slice(0, 4), ipas: ipas.slice(0, 6) };
}

/* ------------------------------------------------------------------ */
/* 钥匙串                                                             */
/* ------------------------------------------------------------------ */

/**
 * 从 macOS 登录钥匙串里翻 Apple ID 凭证，省掉手输。
 *
 * 能读到的三类：
 *   1. ipatool 自己登录成功后写进去的那份（service=ipatool，账号在 acct=account，
 *      密码在 acct=password）——这条能直接恢复登录，连密码都不用输；
 *   2. 系统「登录钥匙串」里存过的 appleid.apple.com / itunes.apple.com 网页密码
 *      （Safari 存到 iCloud 钥匙串的那种读不到，CLI 没有那个 entitlement）；
 *   3. 本机 iCloud 账号（defaults read MobileMeAccounts）——只有邮箱，密码仍要手输。
 *
 * 读 `-w`（取密码本体）时系统可能弹一次「security 想访问钥匙串」的确认框，
 * 所以这里统一压 10s 超时，失败就当成「没读到」，不让整个请求挂死。
 */

const KEYCHAIN_HOSTS = ['appleid.apple.com', 'itunes.apple.com', 'apps.apple.com'];
const SECURITY = '/usr/bin/security';

function security(args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(SECURITY, args, { timeout, maxBuffer: 512 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: err ? String(err.message || err) : '' });
    });
  });
}

/** 取密码本体（-w），拿不到就返回空串 */
async function secret(args, timeout = 10000) {
  const r = await security(args, timeout);
  return r.ok ? r.out.split('\n')[0] : '';
}

/** 只读属性，不碰密码，所以不会触发钥匙串授权弹窗 */
async function accountOf(args) {
  const r = await security(args);
  if (!r.ok) return '';
  const m = r.out.match(/"acct"<blob>="([^"]*)"/);
  return m ? m[1] : '';
}

/** 条目在不在。同样不碰机密字段，不弹授权框 */
async function exists(args) {
  return (await security(args)).ok;
}

let icloudCache;
async function icloudAccount() {
  if (icloudCache !== undefined) return icloudCache;
  icloudCache = await new Promise((resolve) => {
    execFile('/usr/bin/defaults', ['read', 'MobileMeAccounts'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve('');
      // 输出是老式 plist 文本，key 不带引号：AccountID = "824612113@qq.com";
      const m = String(stdout).match(/AccountID\s*=\s*"([^"]+)"/);
      resolve(m ? m[1] : '');
    });
  });
  return icloudCache;
}

/** 内存里的密码副本：2FA 那一步要重跑一次登录，不想再弹一次钥匙串授权 */
const pwdCache = new Map();

async function keychainItems() {
  const items = [];
  const seen = new Map(); // email -> index，同一个账号只留一条，优先带密码的

  const push = (item) => {
    const key = item.email.toLowerCase();
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, items.length);
      items.push(item);
      return;
    }
    if (item.hasPassword && !items[prev].hasPassword) items[prev] = item;
  };

  // 1) ipatool 存的会话。密码条目不读出来——只确认它在，真正取密码要等用户点
  //    「验证并填入」，那时候才该弹系统授权框
  const ip = await accountOf(['find-generic-password', '-s', 'ipatool', '-a', 'account']);
  if (ip) {
    const canFill = await exists(['find-generic-password', '-s', 'ipatool', '-a', 'password']);
    push({
      id: 'ipatool',
      source: 'ipatool',
      label: 'ipatool 已保存',
      email: ip,
      hasPassword: canFill,
    });
  }

  // 2) 登录钥匙串里的网页密码
  for (const host of KEYCHAIN_HOSTS) {
    const acct = await accountOf(['find-internet-password', '-s', host]);
    if (!acct) continue;
    push({
      id: `web:${host}`,
      source: 'keychain',
      label: `钥匙串 · ${host}`,
      email: acct,
      hasPassword: true,
    });
  }

  // 3) 本机 iCloud 账号
  const ic = await icloudAccount();
  if (ic) {
    push({ id: 'icloud', source: 'system', label: '本机 iCloud 账号', email: ic, hasPassword: false });
  }

  return items;
}

/**
 * 把密码真正取出来。这一步才会触发 macOS 的系统授权框 —— security 请求访问该条目
 * 的机密字段，得输本机登录密码并点「允许」，这就是「管理员验证」。
 * 用户取消时 security 非零退出，这里返回 ok:false，让前端退回手填。
 *
 * 超时给到 120 秒：人要看清弹窗、找密码、敲进去，10 秒根本不够，
 * 上一版就是被自己的 10 秒超时掐掉的。
 */
async function fillPassword(id) {
  const items = await keychainItems();
  const it = items.find((x) => x.id === id);
  if (!it) return { ok: false, message: '钥匙串里已经没有这一条了，重新读一次' };
  if (!it.hasPassword) return { ok: false, email: it.email, message: '这条只有账号，钥匙串里没有密码' };

  let pwd = '';
  if (it.id === 'ipatool') {
    pwd = await secret(['find-generic-password', '-s', 'ipatool', '-a', 'password', '-w'], 120000);
  } else if (it.id.startsWith('web:')) {
    pwd = await secret(['find-internet-password', '-s', it.id.slice(4), '-w'], 120000);
  }
  if (!pwd) {
    return {
      ok: false,
      email: it.email,
      message: '没拿到密码：系统授权被取消（或拒绝），也可能这个条目本来就没存密码',
    };
  }
  pwdCache.set(it.id, pwd);
  return { ok: true, email: it.email, password: pwd };
}

/** 用钥匙串里的条目登录；取不到密码就返回 needsPassword，让前端回填账号后手填 */
async function loginFromKeychain({ id, code }) {
  const items = await keychainItems();
  const it = items.find((x) => x.id === id);
  if (!it) return { ok: false, needsPassword: true, message: '钥匙串里已经没有这一条了，重新读一次' };
  let pwd = pwdCache.get(it.id);
  if (!pwd) {
    const filled = await fillPassword(it.id);
    if (!filled.ok) {
      return { ok: false, needsPassword: true, email: it.email, message: filled.message };
    }
    pwd = filled.password;
  }
  return login({ email: it.email, password: pwd, code });
}

module.exports = {
  PLATFORMS,
  resolveBin,
  status,
  login,
  logout,
  versions,
  download,
  cancelCurrent,
  isBusy,
  parseManifest,
  extractTargets,
  keychainItems,
  fillPassword,
  loginFromKeychain,
};
