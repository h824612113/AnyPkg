'use strict';
/**
 * 分段并发下载的验证脚本（一次性，不是项目代码）。
 *
 * 三步：
 *  1. range 服务器 + 每连接限速 200KB/s → 应该切成 4 段，总耗时明显短于单流
 *  2. 同一文件比对 md5，确认没有拼错位
 *  3. 一个不认 Range（永远回 200）的服务器 → 应该自动退回单流，md5 仍然正确
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DownloadQueue } = require('../lib/queue');

const SIZE = 12 * 1024 * 1024;
const RATE = 200 * 1024; // 每条连接 200 KB/s
const SLICE = 32 * 1024;
const GAP = Math.round((SLICE / RATE) * 1000);

function serve(file, { honorRange, flakyStarts = null }) {
  const buf = fs.readFileSync(file);
  const failed = new Set();
  const stat = { served: 0, ranges: [] };
  const server = http.createServer((req, res) => {
    let start = 0;
    let end = buf.length - 1;
    let status = 200;
    const m = honorRange && String(req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Number(m[2]) : buf.length - 1;
      status = 206;
    }
    const body = buf.subarray(start, end + 1);
    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      'accept-ranges': honorRange ? 'bytes' : 'none',
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${buf.length}`;
    res.writeHead(status, headers);
    stat.ranges.push(`${start}-${end}`);

    // 指定的段：第一次连接只吐 500KB 就掐断，模拟「下到一半断了」
    const cut = flakyStarts && flakyStarts.includes(start) && !failed.has(start);
    if (cut) failed.add(start);
    const cutAt = cut ? 500 * 1024 : Infinity;
    let sent = 0;

    // 一片一片吐，片间 sleep，模拟被限速的 CDN
    let pos = 0;
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const pump = () => {
      if (closed) return;
      if (pos >= body.length) {
        res.end();
        return;
      }
      const slice = body.subarray(pos, pos + SLICE);
      pos += slice.length;
      sent += slice.length;
      stat.served += slice.length;
      const ok = res.write(slice);
      if (sent >= cutAt) {
        setTimeout(() => res.destroy(), 50);
        return;
      }
      if (ok) setTimeout(pump, GAP);
      else res.once('drain', () => setTimeout(pump, GAP));
    };
    pump();
  });
  return { server, stat };
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

async function once({ honorRange, label, flakyStarts = null }) {
  const dir = path.join('/tmp', `apd-${label}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const src = path.join(dir, 'src.bin');
  await fsp.writeFile(src, crypto.randomBytes(SIZE));

  const { server, stat } = serve(src, { honorRange, flakyStarts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/pkg.apk`;

  const q = new DownloadQueue({ dir });
  const t0 = Date.now();
  const job = q.add({ url, name: `${label}.apk`, platform: 'android' });

  let sawParallel = 0;
  let last = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const j = q.list().find((x) => x.id === job.id);
    if (j?.parallel) sawParallel = j.parallel;
    const line = `${j.status} ${j.sizeText}/${j.totalText} ${j.speedText} 段=${j.parallel}`;
    if (line !== last && (j.status !== 'downloading' || Date.now() - t0 < 1500)) {
      last = line;
      process.stdout.write(`  ${line}\n`);
    }
    if (j.status === 'done' || j.status === 'error') break;
  }

  const out = path.join(dir, `${label}.apk`);
  const secs = (Date.now() - t0) / 1000;
  const same = md5(out) === md5(src);
  console.log(
    `[${label}] ${secs.toFixed(1)}s  并发段=${sawParallel}  md5一致=${same}  大小=${fs.statSync(out).size}` +
      `  服务器共发出=${(stat.served / 1024 / 1024).toFixed(1)}MB  请求=${stat.ranges.length}`
  );
  server.close();
  await fsp.rm(dir, { recursive: true, force: true });
  return { secs, sawParallel, same, served: stat.served, reqs: stat.ranges.length };
}

async function cancelTest() {
  const dir = '/tmp/apd-cancel';
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const src = path.join(dir, 'src.bin');
  await fsp.writeFile(src, crypto.randomBytes(SIZE));

  const { server } = serve(src, { honorRange: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/pkg.apk`;

  const q = new DownloadQueue({ dir });
  const job = q.add({ url, name: 'cancel.apk', platform: 'android' });
  await new Promise((r) => setTimeout(r, 2500));
  const mid = q.list().find((x) => x.id === job.id);
  q.cancel(job.id);
  await new Promise((r) => setTimeout(r, 1200));
  const after = q.list().find((x) => x.id === job.id);
  const files = await fsp.readdir(dir);
  console.log(
    `[cancel] 取消前=${mid.sizeText}/${mid.totalText} 段=${mid.parallel} 取消后=${after.status}` +
      ` 目录残留=${files.filter((f) => f !== 'src.bin').join(',') || '无'}`
  );
  server.close();
  await fsp.rm(dir, { recursive: true, force: true });
  return { status: after.status, leftover: files.filter((f) => f !== 'src.bin') };
}

(async () => {
  console.log('· 支持 Range，每连接限速 200KB/s');
  const a = await once({ honorRange: true, label: 'range' });
  console.log('· 不认 Range（永远 200）');
  const b = await once({ honorRange: false, label: 'norange' });
  console.log('· 支持 Range，但中间两段第一次各自断在 500KB');
  const seg = Math.ceil(SIZE / 4);
  const c = await once({
    honorRange: true,
    label: 'flaky',
    flakyStarts: [seg, seg * 2],
  });
  console.log('· 下到一半点取消');
  const d = await cancelTest();
  console.log('\n结论：', JSON.stringify({ a, b, c, d }, null, 2));
  if (!a.same || !b.same || !c.same) {
    console.error('md5 不一致，分段写坏了');
    process.exit(1);
  }
  if (a.sawParallel < 2) {
    console.error('没有进入分段模式');
    process.exit(1);
  }
  if (c.served > SIZE * 1.05) {
    console.error('断点没生效，退化成重下了');
    process.exit(1);
  }
  if (d.status !== 'canceled' || d.leftover.length) {
    console.error('取消没有清干净');
    process.exit(1);
  }
})();
