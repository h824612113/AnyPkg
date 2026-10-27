'use strict';

/**
 * 通过 HTTP 验证「直链任务」的重试接口（不是直接调 DownloadQueue，而是走前端用的那条路）。
 */

const http = require('node:http');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(pathname, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: pathname,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
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
            data = { raw: text.slice(0, 200) };
          }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function jobById(id) {
  const r = await request('/api/queue');
  return (r.data.jobs || []).find((j) => j.id === id);
}

async function waitStatus(id, want, ms = 90000) {
  const t0 = Date.now();
  for (;;) {
    const j = await jobById(id);
    if (j && want.includes(j.status)) return j;
    if (Date.now() - t0 > ms) throw new Error(`等 ${want} 超时，当前 ${j && j.status}`);
    await sleep(300);
  }
}

(async () => {
  const add = await request('/api/queue', {
    method: 'POST',
    body: { u: 'https://f-droid.org/repo/anypkg-retry-404.apk', name: 'retry-404.apk', platform: 'android' },
  });
  const id = add.data.job.id;
  console.log(`入队 ${id}`);

  const first = await waitStatus(id, ['error', 'done']);
  console.log(`第一次结束：${first.status} canRetry=${first.canRetry} err=${first.error}`);
  if (first.status !== 'error') throw new Error('404 应该失败');
  if (!first.canRetry) throw new Error('直链失败应该可重试');

  const r = await request('/api/queue/retry', { method: 'POST', body: { id } });
  console.log('重试接口：', r.status, JSON.stringify(r.data).slice(0, 140));
  if (r.status !== 200 || !r.data.ok || r.data.kind !== 'download') throw new Error('重试接口应当成功');

  const again = await waitStatus(id, ['error', 'done']);
  console.log(`第二次结束：${again.status} canRetry=${again.canRetry} err=${again.error}`);
  if (again.status !== 'error') throw new Error('404 重试后仍然应该失败');

  // MCP 走同一个 retryJob：AI 客户端也该能重试，而不是只能重新搜一遍
  const mcp = await request('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'retry_download', arguments: { job_id: id } },
    },
  });
  const text = mcp.data?.result?.content?.[0]?.text || '';
  console.log('MCP retry_download:', mcp.status, text.split('\n')[0]);
  if (mcp.status !== 200 || mcp.data?.result?.isError) throw new Error('MCP retry_download 失败');
  await waitStatus(id, ['error', 'done']);

  // 已完成的任务不允许重试（API 层挡住，别让别的调用方把下好的包重新排一遍）
  const doneJob = (await request('/api/queue')).data.jobs.find((j) => j.status === 'done');
  if (doneJob) {
    const bad = await request('/api/queue/retry', { method: 'POST', body: { id: doneJob.id } });
    console.log(`对已完成任务重试：${bad.status} ${JSON.stringify(bad.data).slice(0, 120)}`);
    if (bad.status !== 400) throw new Error('已完成任务不该允许重试');
  }

  await request('/api/queue/drop', { method: 'POST', body: { id } });
  console.log('直链重试接口通过');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
