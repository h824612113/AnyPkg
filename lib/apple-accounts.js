'use strict';

/**
 * 多 Apple ID 管理。
 *
 * ipatool 2.7（Go 版）把登录凭证存在 macOS 登录钥匙串，不是 ~/.ipatool/cookies
 * （那是 HTTP cookie jar，删掉都不影响 auth info）。条目：
 *   service = "ipatool-auth.service"，account = "account"，内容是不透明 JSON。
 *
 * 所以多账号 = 按账号快照这个钥匙串条目，切换时写回去：
 *   切换到 B = 抓下 A 的条目存快照 → 写入 B 的快照 → auth info 验证
 *
 * 两个实测过的细节（决定体验）：
 * 1. 读 ipatool 自己创建的条目会弹 macOS 授权框（security 不被信任）——所以
 *    「添加账号」时抓一次，用户点允许即可；失败就明说，不静默丢会话。
 * 2. 用 security 写回的条目（-T 带上 ipatool 和 security）之后可以免弹窗读取，
 *    并且 ipatool 也能正常读。所以第一次抓取之后，来回切换都是零提示。
 *
 * 存储位置（都 0600）：
 *   ~/.anypkg/apple/accounts.json            账号清单（email / 备注 / 区 / 密码）
 *   ~/.anypkg/apple/sessions/<hash>.secret   各账号的钥匙串条目快照
 * 密码是 base64（不是加密，只是不裸奔），和项目里 Google 凭证（~/.gplay-auth.json）同一思路。
 * 它只在快照缺失/过期时用于自动重登，那一步仍要两步验证。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const ROOT = path.join(os.homedir(), '.anypkg', 'apple');
const INDEX = path.join(ROOT, 'accounts.json');
const SESS_DIR = path.join(ROOT, 'sessions');

const KEYCHAIN_SERVICE = 'ipatool-auth.service';
const KEYCHAIN_ACCOUNT = 'account';
// -T 只认绝对路径。ipatool 装在 homebrew 的固定位置（resolveBin 也是在这几个目录里找）
const IPATOOL_PATHS = ['/opt/homebrew/bin/ipatool', '/usr/local/bin/ipatool'];
const SECURITY = '/usr/bin/security';

const REGIONS = {
  cn: '中国区',
  us: '美国区',
  jp: '日本区',
  hk: '中国香港区',
  tw: '中国台湾区',
  gb: '英国区',
  other: '其他区',
};

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

function ensureDirs() {
  fs.mkdirSync(SESS_DIR, { recursive: true, mode: 0o700 });
}

function keyOf(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16);
}

function snapshotPath(email) {
  return path.join(SESS_DIR, `${keyOf(email)}.secret`);
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    return {
      active: String(raw.active || ''),
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    };
  } catch {
    return { active: '', accounts: [] };
  }
}

function save(state) {
  ensureDirs();
  const tmp = `${INDEX}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, INDEX);
}

/** 读当前 ipatool 会话。会弹 macOS 授权框（除非该条目是本工具写回的） */
async function readLiveSecret(timeout = 15000) {
  const r = await run(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], timeout);
  const secret = r.stdout.replace(/\n$/, '');
  return r.ok && secret ? secret : '';
}

/** 把快照写回钥匙串。-U 覆盖已有条目；-T 让 ipatool 和 security 都能免授权读写 */
async function writeLiveSecret(secret) {
  const trusted = [];
  for (const p of IPATOOL_PATHS) {
    if (fs.existsSync(p)) {
      trusted.push('-T', p);
      break;
    }
  }
  trusted.push('-T', SECURITY);
  const r = await run(
    SECURITY,
    ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', secret, ...trusted],
    20000
  );
  return r.ok;
}

/** 把当前会话存成某账号的快照 */
async function capture(email, { timeout = 15000 } = {}) {
  const mail = String(email || '').trim();
  if (!mail) return { ok: false, message: 'email 不能为空' };
  const secret = await readLiveSecret(timeout);
  if (!secret) {
    return {
      ok: false,
      code: 'keychain_denied',
      message: '读不到钥匙串里的会话：macOS 弹授权框时要点「允许」（只有第一次需要）。',
    };
  }
  ensureDirs();
  try {
    fs.writeFileSync(snapshotPath(mail), secret, { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `写快照失败：${String(e.message || e)}` };
  }
}

function readSnapshot(email) {
  try {
    const s = fs.readFileSync(snapshotPath(email), 'utf8');
    return s || '';
  } catch {
    return '';
  }
}

/**
 * 登记一个账号（登录成功后调用）。password 可选，给了就存起来，
 * 快照缺失/过期时用来自动重登（2FA 仍要用户确认）。
 */
async function register({ email, password = '', label = '', region = '', name = '', captureSession = true }) {
  const mail = String(email || '').trim();
  if (!mail) return { ok: false, message: 'email 不能为空' };

  const state = load();
  const now = new Date().toISOString();
  let item = state.accounts.find((a) => a.email.toLowerCase() === mail.toLowerCase());

  if (!item) {
    item = { email: mail, label: '', region: '', name: '', password: '', addedAt: now, lastUsedAt: now };
    state.accounts.push(item);
  }
  if (label) item.label = String(label).slice(0, 24);
  if (region) item.region = String(region).slice(0, 8);
  if (name) item.name = String(name).slice(0, 64);
  if (password) item.password = Buffer.from(String(password), 'utf8').toString('base64');
  item.lastUsedAt = now;

  const cap = captureSession ? await capture(mail) : { ok: false };
  state.active = mail;
  save(state);
  return { ok: true, account: item, captured: cap.ok, captureError: cap.ok ? '' : cap.message };
}

/**
 * 切换账号。返回各种「需要用户补一步」的状态：
 *   ok:true                 切好了
 *   code:'need_capture'      当前账号会话没保存成功，切走会丢——先让用户点允许
 *   code:'no_session'        目标账号没有快照（调用方可用存的密码重登，再调 register）
 */
async function switchTo(email) {
  const mail = String(email || '').trim();
  if (!mail) return { ok: false, message: 'email 不能为空' };

  const state = load();
  const target = state.accounts.find((a) => a.email.toLowerCase() === mail.toLowerCase());
  if (!target) return { ok: false, message: '这个账号还没添加过' };

  const activeLow = String(state.active || '').toLowerCase();
  const targetLow = target.email.toLowerCase();
  let warn = '';

  // 先把当前账号的会话保住。已经有快照也再抓一次——用户可能中途重登过，
  // token 换了。抓失败时：有旧快照就继续（旧的可能还能用）；没快照但存了
  // 密码也能靠重登回来，只警告；两样都没有就拒绝（切走就永久丢会话）
  if (state.active && activeLow !== targetLow) {
    const cap = await capture(state.active, { timeout: 8000 });
    if (!cap.ok && !fs.existsSync(snapshotPath(state.active))) {
      if (!getPassword(state.active)) {
        return {
          ok: false,
          code: 'need_capture',
          message: `当前账号 ${state.active} 的会话没能保存（钥匙串授权没通过），也没存密码——切走就回不来了。请先在 macOS 弹框里点「允许」再试，或者用「添加账号」把同一个邮箱再登录一次（顺带把密码存下来）。`,
        };
      }
      warn = `当前账号 ${state.active} 的会话没保存，切回来时需要密码重新验证（已存密码，会自动重登）`;
    }
  }

  const snap = readSnapshot(target.email);
  if (!snap) {
    return {
      ok: false,
      code: 'no_session',
      warn,
      needsPassword: !getPassword(target.email),
      message: '这个账号还没保存过会话快照，需要登录一次（有存密码的话会自动尝试）',
    };
  }

  if (!(await writeLiveSecret(snap))) {
    return { ok: false, code: 'keychain_write_failed', message: '写入钥匙串失败，可能是系统权限问题' };
  }

  const state2 = load();
  state2.active = target.email;
  const it = state2.accounts.find((a) => a.email.toLowerCase() === targetLow);
  if (it) it.lastUsedAt = new Date().toISOString();
  save(state2);
  return { ok: true, account: target, warn };
}

function remove(email) {
  const mail = String(email || '').trim().toLowerCase();
  const state = load();
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((a) => a.email.toLowerCase() !== mail);
  if (state.accounts.length === before) return { ok: false, message: '没有这个账号' };
  try {
    fs.unlinkSync(snapshotPath(mail));
  } catch {
    /* 没有快照文件也无所谓 */
  }
  if (String(state.active).toLowerCase() === mail) state.active = '';
  save(state);
  return { ok: true };
}

function getPassword(email) {
  const state = load();
  const item = state.accounts.find((a) => a.email.toLowerCase() === String(email).trim().toLowerCase());
  if (!item || !item.password) return '';
  try {
    return Buffer.from(item.password, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** 给前端的清单：不含密码本体，只回 hasPassword */
function list() {
  const state = load();
  return {
    active: state.active,
    regions: REGIONS,
    accounts: state.accounts.map((a) => ({
      email: a.email,
      label: a.label || '',
      region: a.region || '',
      regionText: REGIONS[a.region] || a.region || '',
      name: a.name || '',
      hasPassword: Boolean(a.password),
      hasSession: fs.existsSync(snapshotPath(a.email)),
      addedAt: a.addedAt || '',
      lastUsedAt: a.lastUsedAt || '',
      active: a.email.toLowerCase() === String(state.active).toLowerCase(),
    })),
  };
}

module.exports = {
  REGIONS,
  list,
  register,
  switchTo,
  capture,
  remove,
  getPassword,
  readSnapshot,
  snapshotPath,
  readLiveSecret,
  writeLiveSecret,
  KEYCHAIN_SERVICE,
};
