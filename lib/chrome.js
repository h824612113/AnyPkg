'use strict';

/**
 * Chrome 家族浏览器的本机账号探测（macOS）。
 *
 * 为什么值得做：Play 通道的登录本质是「从浏览器里捞一个 oauth_token」。
 * 本机浏览器已经登录了 Google，就不该让人再输一次密码——先把账号列出来，
 * 能复用就直接复用。
 *
 * 两个实测结论决定了实现方式：
 *
 * 1. Cookie 是可解的。v10 = AES-128-CBC，密钥来自 login keychain 的
 *    "<Browser> Safe Storage"（PBKDF2-sha1 / 1003 轮 / 16 字节），解密后前 32 字节
 *    是 sha256(host_key) 防串站前缀（Chrome 127+ 加的），要去掉再取明文。
 *
 * 2. 但「解密出 SID 再拿去换 token」走不通。带上完整 cookie 直接请求
 *    accounts.google.com 能过（myaccount 返回已登录页），一碰 EmbeddedSetup
 *    就跳回 v3/signin——Google 对这条高价值路径加了设备绑定（DBSC），
 *    把 cookie 复制到别的 profile 起 Chrome 也一样被拒（实测过，SID/LSID/OSID 全在，
 *    照样登录页）。所以复用只能走「浏览器自己开着、自己带会话去访问」这一条路：
 *    必须是浏览器没在运行时用它自己的 user-data-dir 起窗口。
 *
 * 因此本模块只负责「看得见」和「能不能复用」两件事，真正的抓 token 在
 * gplay-server/account_auth.py 里做（那边有 CDP 客户端）。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const HOME = os.homedir();
const SUPPORT = path.join(HOME, 'Library', 'Application Support');

const BROWSERS = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    dataDir: path.join(SUPPORT, 'Google', 'Chrome'),
    exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    appName: 'Google Chrome',
    safeStorage: 'Chrome Safe Storage',
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    dataDir: path.join(SUPPORT, 'Microsoft Edge'),
    exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    appName: 'Microsoft Edge',
    safeStorage: 'Microsoft Edge Safe Storage',
  },
  {
    id: 'brave',
    name: 'Brave',
    dataDir: path.join(SUPPORT, 'BraveSoftware', 'Brave-Browser'),
    exe: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    appName: 'Brave Browser',
    safeStorage: 'Brave Safe Storage',
  },
  {
    id: 'chromium',
    name: 'Chromium',
    dataDir: path.join(SUPPORT, 'Chromium'),
    exe: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    appName: 'Chromium',
    safeStorage: 'Chromium Safe Storage',
  },
];

const CHROME_EPOCH_OFFSET_MS = 11644473600000n; // 1601-01-01 → 1970-01-01

/* ------------------------------------------------------------------ */
/* 基础读取                                                             */
/* ------------------------------------------------------------------ */

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** SingletonLock 是指向 "<hostname>-<pid>" 的软链，pid 还活着才算真在跑 */
function isRunning(b) {
  const lock = path.join(b.dataDir, 'SingletonLock');
  let target;
  try {
    target = fs.readlinkSync(lock);
  } catch {
    return false;
  }
  const pid = Number(String(target).split('-').pop());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在、只是不归我们管，照样算在跑
    return e.code === 'EPERM';
  }
}

/** 新版把 Cookies 挪到了 <profile>/Network/ 下，两处都试 */
function cookieFile(dataDir, profileDir) {
  const a = path.join(dataDir, profileDir, 'Network', 'Cookies');
  if (fs.existsSync(a)) return a;
  const b = path.join(dataDir, profileDir, 'Cookies');
  if (fs.existsSync(b)) return b;
  return null;
}

let tmpSeq = 0;
/** Chrome 持有 cookie 库时直接读可能读到半截，复制一份再查 */
async function copyDb(file) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apd-ck-'));
  const dst = path.join(dir, `c-${(tmpSeq += 1)}.db`);
  await fsp.copyFile(file, dst);
  // WAL 里有还没 checkpoint 的写入，一起带过去
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) {
      await fsp.copyFile(file + suffix, dst + suffix).catch(() => {});
    }
  }
  return { dir, dst };
}

/**
 * 有没有可用的 Google 登录会话。只看「SID 存在且没过期」，不解密——
 * 解密要读 keychain，会弹系统授权框，只是列账号时不该打扰人。
 */
async function hasSession(file) {
  if (!DatabaseSync) return false;
  const { dir, dst } = await copyDb(file);
  try {
    const db = new DatabaseSync(dst, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "select name, CAST(expires_utc as TEXT) as exp from cookies " +
            "where host_key like '%google.com' and name in ('SID','__Secure-1PSID')"
        )
        .all();
      if (!rows.length) return false;
      const now = BigInt(Date.now());
      return rows.some((r) => {
        try {
          return BigInt(r.exp) / 1000n - CHROME_EPOCH_OFFSET_MS > now;
        } catch {
          return false;
        }
      });
    } finally {
      db.close();
    }
  } catch {
    return false;
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 对外                                                                */
/* ------------------------------------------------------------------ */

/** 装了哪些浏览器、跑没跑、各自登录了哪些 Google 账号 */
async function accounts() {
  const out = [];
  for (const b of BROWSERS) {
    if (!fs.existsSync(b.dataDir)) continue;
    const state = await readJson(path.join(b.dataDir, 'Local State'));
    const cache = state?.profile?.info_cache || {};
    const running = isRunning(b);

    const profiles = [];
    for (const [dir, info] of Object.entries(cache)) {
      const email = String(info?.user_name || '').trim();
      if (!email) continue; // 没登 Google 的 profile 对 Play 没用
      const file = cookieFile(b.dataDir, dir);
      profiles.push({
        dir,
        name: String(info?.name || dir),
        email,
        gaiaName: String(info?.gaia_name || ''),
        signedIn: file ? await hasSession(file) : false,
      });
    }
    if (!profiles.length) continue;
    // 有会话的排前面，其余按 Chrome 自己的顺序
    profiles.sort((a, c) => Number(c.signedIn) - Number(a.signedIn));
    out.push({ id: b.id, name: b.name, running, profiles });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Cookie 解密（目前只在诊断里用，留着方便以后排障）                     */
/* ------------------------------------------------------------------ */

function safeStorageKey(service) {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', service, '-w'], { timeout: 8000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
}

function decryptRaw(enc, key) {
  if (!enc || enc.length < 4) return null;
  const version = enc.subarray(0, 3).toString('latin1');
  // v20 是 Windows 的 App-Bound 加密，macOS 上不会出现
  if (version !== 'v10' && version !== 'v11') return null;
  const iv = Buffer.alloc(16, 0x20);
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let out = Buffer.concat([d.update(enc.subarray(3)), d.final()]);
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
  return out;
}

/**
 * Chrome 127 之后在明文前塞了 32 字节的 SHA256 校验：Cookie 用 host_key，
 * 密码库用 origin_url（两种都试，再兜底按「头部是二进制」判断）。
 * 不剥掉的话密码前面会粘一段乱码，填进登录框必然失败。
 */
function stripChromiumPrefix(raw, origin) {
  if (!raw || raw.length <= 32) return raw;
  const head = raw.subarray(0, 32);
  const candidates = [origin];
  try {
    const u = new URL(origin);
    candidates.push(u.host, u.hostname);
  } catch {
    /* origin 可能不是合法 URL */
  }
  for (const c of candidates) {
    if (c && head.equals(crypto.createHash('sha256').update(c).digest())) return raw.subarray(32);
  }
  // 明文密码不会有控制字符；有就说明这 32 字节是校验头
  if (head.some((x) => x < 9 || (x > 13 && x < 32) || x > 126)) return raw.subarray(32);
  return raw;
}

function decryptValue(enc, key, hostKey) {
  const raw = decryptRaw(enc, key);
  if (!raw) return '';
  return stripChromiumPrefix(raw, hostKey).toString('utf8');
}

/** 诊断用：把某个 profile 的 Google cookie 解出来（会触发一次 keychain 授权） */
async function inspectCookies(browserId, profileDir = 'Default', hostKey = '.google.com') {
  const b = BROWSERS.find((x) => x.id === browserId);
  if (!b) throw new Error(`没装 ${browserId}`);
  const file = cookieFile(b.dataDir, profileDir);
  if (!file) throw new Error('这个 profile 没有 Cookie 库');
  const pw = await safeStorageKey(b.safeStorage);
  if (!pw) throw new Error('读不到 ' + b.safeStorage + '（钥匙串授权被拒？）');
  const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');

  const { dir, dst } = await copyDb(file);
  try {
    const db = new DatabaseSync(dst, { readOnly: true });
    const rows = db
      .prepare('select host_key, name, encrypted_value from cookies where host_key = ?')
      .all(hostKey);
    db.close();
    return rows.map((r) => ({
      name: r.name,
      value: decryptValue(Buffer.from(r.encrypted_value), key, r.host_key).slice(0, 24) + '…',
    }));
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 从浏览器密码库取某个账号的 Google 密码。
 *
 * Login Data 和 Cookie 库共用同一把 Safe Storage 密钥（PBKDF2 → AES-128-CBC），
 * 所以解密逻辑是同一套。密码只在服务端内存里用一次，回给调用方的只有结果，
 * 不进日志、不进前端。
 *
 * 为什么不在 UI 里让用户「看密码」：这只是为了免去「再开一个空浏览器重新登录」，
 * 不是密码查看器。
 */
async function passwordFor(email, { browserId = 'chrome' } = {}) {
  const want = String(email || '').trim().toLowerCase();
  if (!want || !DatabaseSync) return null;
  const b = BROWSERS.find((x) => x.id === browserId) || BROWSERS.find((x) => fs.existsSync(x.dataDir));
  if (!b) return null;

  const state = await readJson(path.join(b.dataDir, 'Local State'));
  const cache = state?.profile?.info_cache || {};
  const master = await safeStorageKey(b.safeStorage);
  if (!master) return null;
  const key = crypto.pbkdf2Sync(master, 'saltysalt', 1003, 16, 'sha1');

  // 同一个账号可能存在于多个 profile，按 profile 顺序找第一个命中的
  for (const dir of Object.keys(cache)) {
    const file = path.join(b.dataDir, dir, 'Login Data');
    if (!fs.existsSync(file)) continue;
    const { dir: tmp, dst } = await copyDb(file);
    try {
      const db = new DatabaseSync(dst, { readOnly: true });
      let rows = [];
      try {
        rows = db
          .prepare(
            'select origin_url, username_value, password_value from logins ' +
              'where lower(username_value) = ?'
          )
          .all(want);
      } finally {
        db.close();
      }
      for (const r of rows) {
        // 同一条 username 可能挂在不同站点上，只认 Google 的登录入口
        if (!/google\.com/i.test(r.origin_url || '')) continue;
        const raw = decryptRaw(Buffer.from(r.password_value), key);
        if (!raw) continue;
        const password = stripChromiumPrefix(raw, r.origin_url).toString('utf8');
        if (password) return { password, profile: dir, origin: r.origin_url, browser: b.id };
      }
    } catch {
      /* 某个 profile 的库打不开就跳下一个 */
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  return null;
}

/**
 * 从 Chrome 里取 accounts.google.com 的 `oauth_token`。
 *
 * 这是「免密码登录 Play」唯一还活着的一条路。为什么：
 *  - 直接搬 cookie 出去用会被 DBSC（设备绑定）打回登录页，实测三个端点全 302；
 *  - Chrome 又不会把 Google 账号密码存进 Login Data（浏览器自身登录不算表单），
 *    所以密码库和钥匙串里都没有；
 *  - 但 `oauth_token` 是 Google 自己发给「这个已完成验证的浏览器」的一次性票据，
 *    它就在 cookie 库里，能解出来，换 AAS token 一步到位。
 *
 * 代价：必须先让 Chrome 访问一次 EmbeddedSetup 把票据领出来。用户已登录，
 * 所以那一步通常只是点一下「继续」，不用输密码。
 *
 * 票据是一次性的、几分钟就失效，拿到就得立刻去换，不能缓存。
 */
/**
 * 本进程里已经拿去换过 AAS token 的票据。
 *
 * oauth_token 是一次性的，但我们是从 cookie 里读的——换成功之后 Google 并不会
 * 把浏览器里的这条 cookie 删掉。于是下次点「借 Chrome 登录」会捞出同一张死票，
 * 换 token 必然 BadAuthentication，用户看到「又失败了」但其实早就登进去了。
 * 记住用过的，跳过就行。
 */
const consumedTokens = new Set();

async function oauthToken({ timeoutMs = 0, pollMs = 1200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const b of BROWSERS) {
      if (!fs.existsSync(b.dataDir)) continue;
      const state = await readJson(path.join(b.dataDir, 'Local State'));
      for (const dir of Object.keys(state?.profile?.info_cache || {})) {
        const file = cookieFile(b.dataDir, dir);
        if (!file) continue;
        const found = await readOAuthFrom(file, b);
        if (found && !consumedTokens.has(found.token)) {
          const email = String(state?.profile?.info_cache?.[dir]?.user_name || '');
          return { ...found, email, browser: b.id, profile: dir };
        }
      }
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** 换过就登记，避免同一张一次性票据被重复提交 */
function markTokenConsumed(token) {
  if (token) consumedTokens.add(token);
}

/** 单个 Cookies 库里找 oauth_token；没有就直接返回 null，不做无谓的解密 */
async function readOAuthFrom(file, browser) {
  const { dir, dst } = await copyDb(file);
  let row;
  try {
    const db = new DatabaseSync(dst, { readOnly: true });
    try {
      row = db
        .prepare(
          "select host_key, encrypted_value from cookies " +
            "where name = 'oauth_token' and host_key like '%google.com' " +
            'order by creation_utc desc limit 1'
        )
        .get();
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (!row) return null;

  const master = await safeStorageKey(browser.safeStorage);
  if (!master) return null;
  const key = crypto.pbkdf2Sync(master, 'saltysalt', 1003, 16, 'sha1');
  const token = decryptValue(Buffer.from(row.encrypted_value), key, row.host_key || '');
  // oauth2_4/… 才是能换 AAS 的那种；别的值（空串、被清掉的占位）跳过
  if (!/^oauth2/.test(token)) return null;
  return { token };
}

/**
 * 钥匙串里的网页密码。macOS 会在这里弹系统授权（Touch ID / 登录密码），
 * 正是用户要的「请求管理员验证通过了才自动填」。
 */
function keychainPassword(email) {
  return new Promise((resolve) => {
    if (!email) return resolve('');
    execFile(
      'security',
      ['find-internet-password', '-s', 'accounts.google.com', '-a', email, '-w'],
      { timeout: 30000 },
      (err, stdout) => resolve(err ? '' : String(stdout).split('\n')[0].trim())
    );
  });
}

/**
 * 把用户手输一次的密码存进登录钥匙串，下次就能自动取（且每次取都会走系统授权）。
 *
 * 用 `security add-internet-password -w`：`-U` 是覆盖已有条目。
 * 注意密码会以参数形式传给 security，本机进程列表里能看到一瞬间——
 * 单用户机器上可接受，多用户环境就别开这个开关。
 */
function savePassword(email, password) {
  return new Promise((resolve) => {
    if (!email || !password) return resolve({ ok: false, message: '缺邮箱或密码' });
    execFile(
      'security',
      ['add-internet-password', '-s', 'accounts.google.com', '-a', email, '-w', password, '-U'],
      { timeout: 60000 },
      (err, _stdout, stderr) =>
        resolve(err ? { ok: false, message: String(stderr || err.message).trim() } : { ok: true })
    );
  });
}

function available() {
  return BROWSERS.filter((b) => fs.existsSync(b.dataDir)).map((b) => ({
    id: b.id,
    name: b.name,
    running: isRunning(b),
    exe: fs.existsSync(b.exe) ? b.exe : '',
  }));
}

module.exports = {
  accounts,
  available,
  inspectCookies,
  passwordFor,
  keychainPassword,
  savePassword,
  oauthToken,
  markTokenConsumed,
};
