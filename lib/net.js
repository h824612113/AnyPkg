'use strict';

/**
 * 零依赖的出网层。
 *
 * 原生 fetch 不认 HTTPS_PROXY，而 Aptoide / Google 系在这台机器上必须走代理才能连。
 * 这里用 node:http 的 CONNECT 隧道自己拼了一个 https agent，顺便做了两件事：
 *
 *  1. 自动探测本机代理端口（Clash 7897、旧版 7890、Surge 1087 …）
 *  2. 按 host 记住「这个站要不要代理」，直连失败的站点后续直接走代理，不再白等超时
 *
 * 应用宝在国内是直连可达的，Aptoide 不是，所以两条路必须能共存。
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { AsyncLocalStorage } = require('node:async_hooks');

const PROXY_PORTS = [7897, 7890, 1087, 8080, 8888, 6152];
const PROXY_PROBE_TIMEOUT = 300;
// 12s 在出口抖动时太紧：实测整条链路会集体掉到 10s 级，差一点点就全军覆没。
// 16s 让「慢但活着」的请求能回来，聚合层再用 20s 做最终兜底。
const DEFAULT_TIMEOUT = 16000;
const MAX_REDIRECTS = 5;

/**
 * host -> 'proxy' | 'direct'
 *
 * 默认走代理：本机 Clash / Surge 这类客户端自带分流规则，国内站会直连出去，
 * 实测应用宝经代理 0.6s、Aptoide 1.0s，比「先等直连超时」的 7s 快一个数量级。
 * 代理挂了或者某个站被代理拒绝时，再回退直连并把结果记下来。
 */
const HOST_MODE = new Map();
const AGENTS = new Map();
const MAX_HOST_MODES = 256;

function rememberHostMode(host, mode) {
  HOST_MODE.delete(host);
  HOST_MODE.set(host, mode);
  while (HOST_MODE.size > MAX_HOST_MODES) HOST_MODE.delete(HOST_MODE.keys().next().value);
}
const requestContext = new AsyncLocalStorage();

let resolvedProxy;

/* ------------------------------------------------------------------ */
/* 代理探测                                                            */
/* ------------------------------------------------------------------ */

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROXY_PROBE_TIMEOUT, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * 代理地址优先级：PROXY 环境变量 > 本机常见端口。
 * 特意不读 HTTPS_PROXY——宿主环境里那个是桌面客户端的内部代理，
 * 拿它去连 Aptoide 会直接 502。
 */
async function detectProxy({ refresh = false } = {}) {
  // 只缓存「探到了」的结果。端口没开是瞬时状态（代理刚启动 / 刚重启），
  // 缓存 null 会让整个进程后续都直连，Apple 的下载 CDN 直连必然失败。
  if (!refresh && resolvedProxy) return resolvedProxy;

  const explicit = (process.env.PROXY || process.env.ANYPROXY || '').trim();
  if (explicit) {
    resolvedProxy = /^https?:\/\//.test(explicit) ? explicit : `http://${explicit}`;
    return resolvedProxy;
  }

  for (const port of PROXY_PORTS) {
    if (await portOpen(port)) {
      resolvedProxy = `http://127.0.0.1:${port}`;
      return resolvedProxy;
    }
  }

  resolvedProxy = null;
  return resolvedProxy;
}

function resetProxy() {
  resolvedProxy = undefined;
  HOST_MODE.clear();
  AGENTS.clear();
}

/* ------------------------------------------------------------------ */
/* CONNECT 隧道                                                        */
/* ------------------------------------------------------------------ */

function connectTunnel(proxyUrl, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, 'proxy-connection': 'keep-alive' },
      timeout,
    });

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(new Error('proxy connect timeout')));
    req.once('error', reject);
    req.end();
  });
}

class TunnelAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: true, maxSockets: 12 });
    this.proxyUrl = proxyUrl;
  }

  createConnection(options, callback) {
    connectTunnel(this.proxyUrl, options.host, options.port || 443, DEFAULT_TIMEOUT)
      .then((socket) => {
        const secured = tls.connect({
          socket,
          servername: options.servername || options.host,
          ALPNProtocols: ['http/1.1'],
        });
        secured.once('secureConnect', () => callback(null, secured));
        secured.once('error', callback);
      })
      .catch(callback);
  }
}

function agentFor(proxyUrl) {
  let agent = AGENTS.get(proxyUrl);
  if (!agent) {
    agent = new TunnelAgent(proxyUrl);
    AGENTS.set(proxyUrl, agent);
  }
  return agent;
}

/* ------------------------------------------------------------------ */
/* 单次请求                                                            */
/* ------------------------------------------------------------------ */

function requestOnce(
  url,
  { headers = {}, timeout = DEFAULT_TIMEOUT, proxy = null, method = 'GET', body = null, signal } = {}
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }

    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const port = Number(target.port) || (isHttps ? 443 : 80);
    const baseHeaders = { host: target.host, 'accept-encoding': 'identity', ...headers };

    let options;
    let mod;

    if (isHttps) {
      mod = https;
      options = {
        method,
        hostname: target.hostname,
        port,
        path: target.pathname + target.search,
        headers: baseHeaders,
        timeout,
        agent: proxy ? agentFor(proxy) : undefined,
      };
    } else if (proxy) {
      // 明文 HTTP 走代理：直接向代理发 absolute-form 请求
      const p = new URL(proxy);
      mod = http;
      options = {
        method,
        hostname: p.hostname,
        port: p.port || 80,
        path: url,
        headers: baseHeaders,
        timeout,
      };
    } else {
      mod = http;
      options = {
        method,
        hostname: target.hostname,
        port,
        path: target.pathname + target.search,
        headers: baseHeaders,
        timeout,
      };
    }

    let response;
    const onAbort = () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      if (response) response.destroy(err);
      else req.destroy(err);
      reject(err);
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    const req = mod.request(options, (res) => {
      response = res;
      res.once('close', cleanup);
      // 连接阶段用短超时快速失败；拿到响应后换成空闲超时，
      // 否则几百 MB 的 APK 下到一半会被"总时长"掐断
      req.setTimeout(0);
      resolve({ status: res.statusCode || 0, headers: res.headers, stream: res, req });
    });

    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', (err) => {
      cleanup();
      reject(err);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    req.end(body || undefined);
  });
}

/**
 * 打开一个可读流，自动跟随重定向。
 * 返回 { status, headers, stream, finalUrl }。
 */
async function openStream(url, opts = {}) {
  let current = url;
  let send = opts;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (opts.validateUrl) await opts.validateUrl(current);
    const res = await requestOnce(current, send);
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc) {
      res.stream.resume(); // 丢弃重定向响应体，释放连接
      current = new URL(loc, current).toString();
      // 303 与绝大多数 302 之后都该换成 GET；再把 body 重发一遍会 400
      send = { ...send, method: 'GET', body: null, headers: { ...send.headers } };
      delete send.headers['content-length'];
      continue;
    }
    if (opts.idleTimeout && res.stream.socket) {
      const socket = res.stream.socket;
      socket.setTimeout(opts.idleTimeout, () => {
        res.stream.destroy(new Error('idle timeout'));
      });
    }
    return { ...res, finalUrl: current };
  }
  throw new Error('too many redirects');
}

/**
 * 迟迟没响应就并行开另一条路（happy eyeballs），谁先成功用谁。
 *
 * 为什么不能只是「失败后再换」：换路要等前一条自己超时，而 DEFAULT_TIMEOUT 是 16s，
 * 聚合层给每个源总共只有 20s——只要有一条路卡住，第二条路根本没机会跑完。
 * 实测把代理指到一个「接受连接但不回响应」的端口（Clash 切节点、TUN 重启瞬间就是这个形态）：
 * 串行 fallback 要 16.4~17.1s 才回来，此时别的源还在抢带宽，一不小心就过 20s，
 * 整栏变红。而用户看到的就是「有时候源连不上」。
 *
 * 快的时候一条连接都不多开：只有主路超过 HEDGE_DELAY 还没回、或者它已经失败，才会开第二条。
 */
const HEDGE_DELAY = 2500;
// 调用方自己给的超时超过这个数，说明它预期是一次长传输（大文件/大索引），
// 2.5s 的卡顿对它没有意义，而对冲会让同一份数据下两遍
const HEDGE_MAX_TIMEOUT = 25000;

function hedgedOpen(mode, call) {
  const alt = mode === 'proxy' ? 'direct' : 'proxy';

  return new Promise((resolve, reject) => {
    let settled = false;
    let altStarted = false;
    let alive = 0;
    let lastError = null;
    let timer = null;

    const succeed = (res, m) => {
      if (settled) {
        // 迟到的那个：连接已经建好，必须主动断掉，否则它会继续把响应体读进内存
        res.stream.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ res, mode: m });
    };

    const fail = (e) => {
      if (settled) return;
      alive -= 1;
      lastError = e;
      // 主路先挂就别等了，立刻开另一条（和原来的 fallback 一致，只是不等它超时）
      if (!altStarted) {
        startAlt();
        return;
      }
      if (alive === 0) {
        settled = true;
        clearTimeout(timer);
        reject(lastError);
      }
    };

    const run = (m) => {
      alive += 1;
      call(m).then(
        (res) => {
          // 502/504 是代理层自己吐的，拿到也不算成功
          if (res.status === 502 || res.status === 504) {
            res.stream.resume();
            fail(new Error(`proxy returned ${res.status}`));
            return;
          }
          succeed(res, m);
        },
        (e) => fail(e)
      );
    };

    function startAlt() {
      if (altStarted || settled) return;
      altStarted = true;
      clearTimeout(timer);
      run(alt);
    }

    timer = setTimeout(startAlt, HEDGE_DELAY);
    timer.unref?.();
    run(mode);
  });
}

/**
 * 代理优先，代理不通再回退直连；结果按 host 缓存，避免反复试错。
 * opts.prefer = 'direct' 用于大文件下载：国内 CDN 直连更快，也不必让代理扛几百 MB。
 */
async function smartOpen(url, opts = {}) {
  const host = new URL(url).hostname;
  const signal = opts.signal || requestContext.getStore()?.signal;
  const requestOpts = signal ? { ...opts, signal } : opts;
  const proxy = await detectProxy();

  if (!proxy) return openStream(url, requestOpts);
  if (opts.forceProxy) return openStream(url, { ...requestOpts, proxy });

  // 缓存优先，其次才是调用方的偏好：搜索接口走过一次直连失败后就该记住，别每次都白等。
  // 大文件下载（hardPrefer）是例外——几百 MB 走代理会拖垮带宽，宁可先试直连。
  const learned = HOST_MODE.get(host);
  const mode = opts.hardPrefer ? opts.prefer || 'direct' : learned || opts.prefer || 'proxy';
  const call = (m) => openStream(url, m === 'proxy' ? { ...requestOpts, proxy } : requestOpts);

  // 大文件下载不许对冲：两条流会互相抢带宽。它的容错由 Range 续传负责，不是靠换路。
  // noFallback 是对冲的反面语义（调用方自己有降级，别再开第二条），保持单路。
  // 超时特别长的调用（winget 的 21MB 索引给 120s）也排除：2.5s 的卡顿对它不是事，
  // 但对冲会让 21MB 下两遍。
  const budget = opts.timeout || DEFAULT_TIMEOUT;
  if (!opts.hardPrefer && !opts.noFallback && opts.hedge !== false && budget <= HEDGE_MAX_TIMEOUT) {
    const { res, mode: won } = await hedgedOpen(mode, call);
    if (won !== learned) rememberHostMode(host, won);
    return res;
  }

  if (mode === 'direct') {
    try {
      return await openStream(url, requestOpts);
    } catch (e) {
      rememberHostMode(host, 'proxy');
      if (opts.noFallback) throw e;
      return openStream(url, { ...requestOpts, proxy });
    }
  }

  try {
    const res = await openStream(url, { ...requestOpts, proxy });
    // 502/504 是代理层的典型失败信号，拿到也不算数，换直连再试一次
    if (res.status === 502 || res.status === 504) {
      res.stream.resume();
      throw new Error(`proxy returned ${res.status}`);
    }
    return res;
  } catch (e) {
      rememberHostMode(host, 'direct');
    return openStream(url, requestOpts);
  }
}

function runWithRequestContext(signal, fn) {
  return requestContext.run({ signal }, fn);
}

/* ------------------------------------------------------------------ */
/* 便捷封装                                                            */
/* ------------------------------------------------------------------ */

function readAll(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        stream.destroy();
        reject(new Error('response too large'));
        return;
      }
      chunks.push(c);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.once('error', reject);
  });
}

async function smartText(
  url,
  { headers = {}, timeout = DEFAULT_TIMEOUT, maxBytes = 8 * 1024 * 1024, forceProxy, prefer, noFallback, hardPrefer, hedge, signal } = {}
) {
  const res = await smartOpen(url, { headers, timeout, forceProxy, prefer, noFallback, hardPrefer, hedge, signal });
  if (res.status < 200 || res.status >= 300) {
    res.stream.resume();
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return readAll(res.stream, maxBytes);
}

async function smartJson(url, opts = {}) {
  const body = await smartText(url, {
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers || {}) },
  });
  return JSON.parse(body);
}

/**
 * POST JSON。Flathub 的搜索只开了 POST（GET 直接 405），
 * 而它和大多数站一样不认原生 fetch 的代理设置，所以还得走 smartOpen。
 */
async function smartPostJson(url, payload, { headers = {}, timeout = DEFAULT_TIMEOUT, ...rest } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const res = await smartOpen(url, {
    method: 'POST',
    body,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': body.length,
      ...headers,
    },
    timeout,
    ...rest,
  });
  if (res.status < 200 || res.status >= 300) {
    res.stream.resume();
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(await readAll(res.stream, 8 * 1024 * 1024));
}

/** 当前代理状态，给 /api/health 用 */
async function proxyStatus() {
  const proxy = await detectProxy();
  return { proxy, directHosts: [...HOST_MODE.entries()].filter(([, m]) => m === 'direct').map(([h]) => h) };
}

module.exports = {
  detectProxy,
  resetProxy,
  openStream,
  smartOpen,
  smartText,
  smartJson,
  smartPostJson,
  proxyStatus,
  runWithRequestContext,
};
