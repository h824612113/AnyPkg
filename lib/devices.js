'use strict';

/**
 * 设备安装：把下好的包直接推到连着这台电脑的手机上。
 *
 * Android 走 adb（Android SDK platform-tools 自带，几乎人人都有）；
 * iOS 走 pymobiledevice3（纯 Python，不需要越狱、不需要 Xcode）。
 *
 * 两件事必须记住：
 *  1. 这里只是本机工具，不联任何云；设备列表来自 USB，断开就没了。
 *  2. iOS 装不装得上取决于包的签名。App Store 下到的 IPA 是 FairPlay 加密、
 *     绑账号的，installation_proxy 会拒；能装的是自己重签过的或企业签名的包。
 *     所以失败时要把这条原因直接告诉用户，别让他以为是工具坏了。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');

const ADB_CANDIDATES = [
  process.env.ADB_BIN,
  path.join(os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
  '/opt/homebrew/bin/adb',
  '/usr/local/bin/adb',
  '/usr/bin/adb',
].filter(Boolean);

// pymobiledevice3 没有 brew 包，通常装在某个 Python 环境里。
// 下面两个是 WorkBuddy 隔离环境（gplay-server 用的同一个），装一次两边都能用。
const PMD3_CANDIDATES = [
  process.env.PYMOBILEDEVICE3_BIN,
  path.join(os.homedir(), '.workbuddy/binaries/python/envs/default/bin/pymobiledevice3'),
  path.join(os.homedir(), '.workbuddy-ai/binaries/python/envs/default/bin/pymobiledevice3'),
  '/opt/homebrew/bin/pymobiledevice3',
  '/usr/local/bin/pymobiledevice3',
].filter(Boolean);

const DEVICE_TTL = 10000;
let cache = null;
let cacheAt = 0;

function run(bin, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ''}` },
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          message: err ? String(err.message || err) : '',
        });
      }
    );
  });
}

async function findBin(candidates, name) {
  for (const cand of candidates) {
    try {
      await fsp.access(cand, fs.constants.X_OK);
      return cand;
    } catch {
      /* 下一个 */
    }
  }
  const probe = await run('which', [name], 4000);
  return probe.code === 0 ? probe.stdout.trim().split('\n')[0] : '';
}

/** 解析 `adb devices -l`：第一列序列号，第二列状态，后面是 key:value */
function parseAdbList(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || /^List of devices/.test(t) || t.startsWith('*')) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state, ...rest] = parts;
    const props = {};
    for (const kv of rest) {
      const i = kv.indexOf(':');
      if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const model = (props.model || '').replace(/_/g, ' ');
    out.push({
      id: serial,
      serial,
      platform: 'android',
      name: model || serial,
      state,
      ready: state === 'device',
      detail: [
        state !== 'device' ? STATE_LABEL[state] || state : '',
        props.device ? props.device : '',
        props.transport_id ? `#${props.transport_id}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return out;
}

const STATE_LABEL = {
  unauthorized: '未授权（手机上点「允许」）',
  offline: '离线',
  recovery: 'recovery 模式',
  bootloader: 'bootloader 模式',
  'no': '无权限',
};

/** pymobiledevice3 usbmux list 的输出是 JSON 数组，字段名随版本变过，两种都认 */
function parsePmd3List(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  let arr;
  try {
    arr = JSON.parse(raw.slice(raw.indexOf('[')));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((d) => {
      const id = d.Identifier || d.UniqueDeviceID || d.SerialNumber || '';
      if (!id) return null;
      return {
        id,
        udid: id,
        platform: 'ios',
        name: d.DeviceName || d.ProductType || id.slice(0, 8),
        state: 'device',
        ready: true,
        detail: [d.ProductType, d.ProductVersion ? `iOS ${d.ProductVersion}` : '', d.ConnectionType]
          .filter(Boolean)
          .join(' · '),
      };
    })
    .filter(Boolean);
}

async function detect(force = false) {
  if (!force && cache && Date.now() - cacheAt < DEVICE_TTL) return cache;

  const tools = {
    adb: { available: false, path: '' },
    pymobiledevice3: { available: false, path: '' },
  };
  const devices = [];

  tools.adb.path = await findBin(ADB_CANDIDATES, 'adb');
  tools.adb.available = Boolean(tools.adb.path);

  if (tools.adb.available) {
    const r = await run(tools.adb.path, ['devices', '-l'], 8000);
    devices.push(...parseAdbList(r.stdout));
  }

  tools.pymobiledevice3.path = await findBin(PMD3_CANDIDATES, 'pymobiledevice3');
  tools.pymobiledevice3.available = Boolean(tools.pymobiledevice3.path);

  if (tools.pymobiledevice3.available) {
    const r = await run(tools.pymobiledevice3.path, ['usbmux', 'list'], 10000);
    devices.push(...parsePmd3List(r.stdout));
  }

  cache = { tools, devices };
  cacheAt = Date.now();
  return cache;
}

function invalidate() {
  cache = null;
  cacheAt = 0;
}

/** 只允许装 .downloads 里的文件，别把任意路径喂给 adb */
function safeFile(dir, name) {
  const base = path.basename(String(name || ''));
  if (!base || base.startsWith('.')) return '';
  const full = path.join(dir, base);
  if (!path.resolve(full).startsWith(path.resolve(dir) + path.sep)) return '';
  return full;
}

async function unzipApks(zipPath) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apd-splits-'));
  const r = await run('unzip', ['-o', '-q', zipPath, '-d', dir], 120000);
  if (r.code !== 0) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error(`解包失败：${(r.stderr || r.message).slice(-200)}`);
  }
  const found = [];
  async function walk(d) {
    for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (/\.apk$/i.test(ent.name)) found.push(p);
    }
  }
  await walk(dir);
  return { dir, apks: found };
}

const IOS_SIGNED_HINT =
  'App Store 下到的 IPA 是 FairPlay 加密、绑账号的，installation_proxy 会拒绝安装。' +
  '能装的是自己重签过、或企业签名分发的 IPA；官方的请直接在手机上的 App Store 里装。';

/**
 * @param {{platform:string, device:string, file:string, dir:string}} opts
 * @returns {Promise<{ok:boolean, log:string, hint?:string}>}
 */
async function install({ platform, device, file, dir }) {
  const full = safeFile(dir, file);
  if (!full) return { ok: false, log: '文件名不合法' };
  try {
    await fsp.access(full);
  } catch {
    return { ok: false, log: '文件不在下载目录里，可能已被清理' };
  }

  const info = await detect(true);
  const target = info.devices.find((d) => d.id === device);
  if (!target) return { ok: false, log: '设备不在了，重新插一下 USB 并刷新' };
  if (!target.ready) {
    return { ok: false, log: `设备当前状态：${target.detail || target.state}` };
  }

  if (platform === 'android') {
    if (!info.tools.adb.available) return { ok: false, log: '本机没有 adb（装 Android SDK platform-tools）' };

    let args;
    let tmp = '';
    if (/\.(zip|xapk|apks)$/i.test(full)) {
      // Play 的 App Bundle 是 base + splits，必须 install-multiple 一起推，单个装会缺资源
      let unzipped;
      try {
        unzipped = await unzipApks(full);
      } catch (e) {
        return { ok: false, log: String(e.message || e) };
      }
      tmp = unzipped.dir;
      if (!unzipped.apks.length) {
        await fsp.rm(tmp, { recursive: true, force: true });
        return { ok: false, log: '压缩包里没有 .apk' };
      }
      args = unzipped.apks.length > 1 ? ['install-multiple', '-r', ...unzipped.apks] : ['install', '-r', unzipped.apks[0]];
    } else if (/\.apk$/i.test(full)) {
      args = ['install', '-r', full];
    } else {
      return { ok: false, log: '这个文件不是 APK / XAPK，装不到 Android 上' };
    }

    const r = await run(info.tools.adb.path, ['-s', device, ...args], 600000);
    if (tmp) fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    const log = `${r.stdout}\n${r.stderr}`.trim();
    return { ok: r.code === 0 && /Success/i.test(log), log: log.slice(-1200) };
  }

  if (platform === 'ios') {
    if (!info.tools.pymobiledevice3.available) {
      return {
        ok: false,
        log:
          '本机没有 pymobiledevice3。装一个：\n' +
          'python3 -m pip install pymobiledevice3',
      };
    }
    if (!/\.ipa$/i.test(full)) return { ok: false, log: 'iOS 只能装 .ipa' };

    const bin = info.tools.pymobiledevice3.path;
    let r = await run(bin, ['apps', 'install', full, '--udid', device], 600000);
    // 老版本的 --udid 是根级选项，新版本放在子命令里；两种写法都试一次
    if (r.code !== 0 && /unrecognized arguments|no such option|Unknown option/i.test(r.stderr + r.message)) {
      r = await run(bin, ['--udid', device, 'apps', 'install', full], 600000);
    }
    const log = `${r.stdout}\n${r.stderr}`.trim();
    const ok = r.code === 0 && !/error/i.test(r.stderr);
    return { ok, log: log.slice(-1200), hint: ok ? '' : IOS_SIGNED_HINT };
  }

  return { ok: false, log: `不认识的平台：${platform}` };
}

module.exports = { detect, invalidate, install, safeFile };
