'use strict';

/**
 * 验证队列面板的「重试」：
 *  1. 直链任务失败后 canRetry 为 true；
 *  2. retry() 原地复活同一个 id，并且从 .part 的断点续，而不是从头下一遍；
 *  3. 分段模式下重试也能正常完成（md5 一致）。
 *
 * 本地起一个会「吐一半就掐断」的服务器，模拟移动网络下真实的失败。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { DownloadQueue } = require('../lib/queue');

const SIZE = 8 * 1024 * 1024;
const SLICE = 64 * 1024;
const GAP = 4;

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function serve(buf, state) {
  return http.createServer((req, res) => {
    if (state.mode === 'fail') {
      res.writeHead(503).end('down');
      return;
    }
    let start = 0;
    let end = buf.length - 1;
    let status = 200;
    const m = String(req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : buf.length - 1;
      status = 206;
    }
    const body = buf.subarray(start, end + 1);
    const headers = {
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes',
    };
    // 分段模式下服务端必须回 Content-Range，探测和续传都靠它
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${buf.length}`;
    // 只在«掐断»模式下少给一段。注意 content-length 仍然报完整长度：
    // 真实的掉线就是这样——服务端说「有 3 MB」，实际只发到一半连接就断了。
    // 如果这里把 content-length 改成 1.2 MB，客户端会当成一个只有 1.2 MB 的完整文件。
    const cut = state.mode === 'cut' ? Math.max(1, Math.floor(body.length * 0.4)) : body.length;
    headers['content-length'] = body.length;
    res.writeHead(status, headers);
    state.served += cut;

    let pos = 0;
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const pump = () => {
      if (closed) return;
      if (pos >= cut) {
        // 掐断：不是 res.end()，是直接销毁，和真的掉线一样
        if (state.mode === 'cut') res.destroy();
        else res.end();
        return;
      }
      const slice = body.subarray(pos, Math.min(pos + SLICE, cut));
      pos += slice.length;
      const ok = res.write(slice);
      if (ok) setTimeout(pump, GAP);
      else res.once('drain', () => setTimeout(pump, GAP));
    };
    pump();
  });
}

async function waitIdle(q, id, ms = 60000) {
  const t0 = Date.now();
  let maxParallel = 0;
  for (;;) {
    const j = q.list().find((x) => x.id === id);
    if (j) maxParallel = Math.max(maxParallel, j.parallel || 0);
    if (j && j.status !== 'downloading' && j.status !== 'queued') return { job: j, maxParallel };
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function scenario({ label, parts, mode, expectParallel }) {
  process.env.APD_DOWNLOAD_PARTS = String(parts);
  const dir = path.join('/tmp', `apd-retry-${label}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  const src = path.join(dir, 'src.bin');
  await fsp.writeFile(src, crypto.randomBytes(SIZE));
  const state = { mode, served: 0 };

  const server = serve(fs.readFileSync(src), state);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/pkg.apk`;

  const q = new DownloadQueue({ dir });
  const added = q.add({ url, name: `${label}.apk`, platform: 'android' });
  const firstOut = await waitIdle(q, added.id);
  const first = firstOut.job;
  const part = path.join(dir, `${label}.apk.part`);
  const partSize = fs.existsSync(part) ? fs.statSync(part).size : 0;

  if (first.status !== 'error') {
    throw new Error(
      `${label}: 第一次应该失败，实际 ${first.status} bytes=${first.bytes} total=${first.total} err=${first.error}`
    );
  }
  if (!first.canRetry) throw new Error(`${label}: canRetry 应该为 true`);
  if (first.errorCode) throw new Error(`${label}: 直链任务不该有 errorCode`);

  // 换成正常服务器，点"重试"
  state.mode = 'ok';
  state.served = 0;
  const out = q.retry(added.id);
  if (out.error) throw new Error(`${label}: retry 报错 ${out.error}`);
  if (out.job.id !== added.id) throw new Error(`${label}: 重试换了 id，等于新建了一条任务`);

  const doneOut = await waitIdle(q, added.id);
  const done = doneOut.job;
  const outFile = path.join(dir, `${label}.apk`);
  const same = fs.existsSync(outFile) && md5(outFile) === md5(src);
  const saved = 1 - state.served / SIZE;

  console.log(
    `[${label}] 失败时 .part=${(partSize / 1024 / 1024).toFixed(2)}MB  ` +
      `重试收到=${(state.served / 1024 / 1024).toFixed(2)}MB（省 ${(saved * 100).toFixed(0)}%）  ` +
      `段=${doneOut.maxParallel}  md5一致=${same}  状态=${done.status}`
  );

  server.close();
  await fsp.rm(dir, { recursive: true, force: true });

  if (!same) throw new Error(`${label}: md5 不一致`);
  if (expectParallel && doneOut.maxParallel < 2) throw new Error(`${label}: 重试没进分段模式`);
  if (!expectParallel && state.served >= SIZE * 0.95) throw new Error(`${label}: 断点没生效，整包重下了`);
  return { partSize, served: state.served, maxParallel: doneOut.maxParallel };
}

(async () => {
  console.log('· 单流模式：失败后重试应从 .part 续');
  await scenario({ label: 'single', parts: 1, mode: 'cut', expectParallel: false });

  console.log('· 分段模式：503 失败后重试应切成 4 段并下完');
  await scenario({ label: 'parallel', parts: 4, mode: 'fail', expectParallel: true });
  console.log('\n全部通过');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
