'use strict';
/**
 * Google Play 旁路服务的客户端。
 *
 * Play 的鉴权（oauth_token → AAS token）、设备指纹轮换、split 合并、重签名
 * 全在 gplay-server（Python + gpapi + APKEditor）里，这里只负责调度。
 * 走本机 http，不用 lib/net 的代理逻辑：那个是给外网用的，连 127.0.0.1 会绕远路。
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.GPLAY_PORT || 5001);
const HOST = '127.0.0.1';
const ROOT = path.join(__dirname, '..', 'gplay-server');
const SCRIPT = path.join(ROOT, 'run.sh');

let child = null;
let starting = null;

function request(pathname, { method = 'GET', body, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: pathname,
        method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = { raw: text.slice(0, 400) };
          }
          resolve({ status: res.statusCode || 0, data });
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('gplay timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 拿一个上游流（SSE 或文件），交给调用方自己 pipe */
function openStream(pathname, { method = 'GET', body, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = payload
      ? { 'content-type': 'application/json', 'content-length': payload.length }
      : {};
    const req = http.request({ host: HOST, port: PORT, path: pathname, method, headers }, (res) => {
      resolve({ status: res.statusCode || 0, headers: res.headers, stream: res, abort: () => req.destroy() });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('gplay timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 服务活着就算可用：/health 在磁盘紧张时返回 503，但接口是通的 */
async function isUp(timeout = 1500) {
  try {
    const r = await request('/health', { timeout });
    return r.status === 200 || r.status === 503;
  } catch {
    return false;
  }
}

/**
 * 按需拉起 Python 服务。首次启动要建 gsfId、上传设备配置，十几秒是正常的，
 * 所以这里给 40 秒窗口，失败就让 Play 源降级为「不可用」而不是拖垮整次搜索。
 */
async function ensure() {
  if (await isUp()) return true;
  if (starting) return starting;
  if (!fs.existsSync(SCRIPT)) return false;

  starting = (async () => {
    let log = 'ignore';
    try {
      log = fs.openSync(path.join(ROOT, 'server.log'), 'a');
    } catch {
      /* 日志写不了不影响启动 */
    }
    child = spawn('/bin/zsh', [SCRIPT], {
      cwd: ROOT,
      stdio: ['ignore', log, log],
      env: { ...process.env, PORT: String(PORT), HOST },
    });
    child.on('exit', () => {
      child = null;
    });

    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isUp(800)) return true;
      if (!child) return false; // 进程已经挂了，别继续等
    }
    return false;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function status() {
  const up = await isUp();
  if (!up) return { up: false, authenticated: false, email: '', ready: false };
  let auth = { authenticated: false };
  try {
    const r = await request('/api/auth/status', { timeout: 4000 });
    auth = r.data || auth;
  } catch {
    /* 状态拿不到就当未登录 */
  }
  return {
    up: true,
    ready: true,
    authenticated: Boolean(auth.authenticated),
    email: auth.email || '',
    accountType: auth.accountType || '',
  };
}

async function search(term) {
  const r = await request(`/api/search?q=${encodeURIComponent(term)}`, { timeout: 45000 });
  if (r.status !== 200 || !Array.isArray(r.data?.results)) return [];
  return r.data.results;
}

async function logout() {
  const r = await request('/api/auth/google/logout', { method: 'POST', body: {}, timeout: 8000 });
  return r.status === 200;
}

/** 停掉我们拉起的那个子进程（仅用于退出时清理） */
function shutdown() {
  if (child) {
    try {
      child.kill();
    } catch {
      /* 已经退了就算了 */
    }
    child = null;
  }
}

module.exports = { ensure, isUp, status, search, logout, openStream, request, shutdown, PORT };
