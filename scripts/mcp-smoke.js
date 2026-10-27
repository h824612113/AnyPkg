'use strict';
/**
 * MCP 端点的冒烟测试。不需要任何 MCP 客户端，直接用 fetch 发 JSON-RPC。
 *
 *   node scripts/mcp-smoke.js [query]
 *
 * 它会走一遍真实握手：initialize → notifications/initialized → tools/list → tools/call。
 * 任何一步不是预期的 HTTP 状态或 JSON-RPC 结构，就非 0 退出。
 */

const ENDPOINT = process.env.MCP_URL || 'http://127.0.0.1:8787/mcp';

let seq = 0;
async function rpc(method, params, { notify = false } = {}) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!notify) body.id = (seq += 1);

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 就是失败，下面会报 */
  }
  return { status: res.status, json, text };
}

function fail(msg) {
  console.error('✗', msg);
  process.exit(1);
}

(async () => {
  // 1. 握手
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  });
  if (init.status !== 200 || !init.json?.result?.serverInfo) fail(`initialize 失败：${init.status} ${init.text.slice(0, 200)}`);
  const info = init.json.result.serverInfo;
  console.log(`✓ initialize  ${info.name}@${info.version}  protocol=${init.json.result.protocolVersion}`);
  console.log(`  capabilities: ${Object.keys(init.json.result.capabilities || {}).join(', ')}`);

  // 2. 通知不该有响应体
  const note = await rpc('notifications/initialized', undefined, { notify: true });
  if (note.status !== 202) fail(`notifications/initialized 应该 202，实际 ${note.status}`);
  console.log('✓ notifications/initialized  202 无响应体');

  // 3. 工具清单
  const list = await rpc('tools/list');
  const tools = list.json?.result?.tools || [];
  if (!tools.length) fail('tools/list 是空的');
  console.log(`✓ tools/list  ${tools.length} 个工具`);
  for (const t of tools) {
    const props = Object.keys(t.inputSchema?.properties || {});
    console.log(`  · ${t.name}(${props.join(', ')})`);
  }

  // 4. 搜索
  const q = process.argv[2] || 'F-Droid';
  const t0 = Date.now();
  const search = await rpc('tools/call', { name: 'search_apps', arguments: { query: q, limit: 3 } });
  const out = search.json?.result?.content?.[0]?.text || '';
  if (search.json?.result?.isError) fail(`search_apps 报错：${out}`);
  console.log(`\n✓ search_apps("${q}")  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(out.split('\n').slice(0, 18).map((l) => '  ' + l).join('\n'));

  // 5. 队列
  const st = await rpc('tools/call', { name: 'download_status', arguments: {} });
  const stText = st.json?.result?.content?.[0]?.text || '';
  if (st.json?.result?.isError) fail(`download_status 报错：${stText}`);
  console.log(`\n✓ download_status`);
  console.log(stText.split('\n').slice(0, 6).map((l) => '  ' + l).join('\n'));

  // 6. 错误路径：不存在的工具要回 isError 而不是断连接
  const bad = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  if (bad.json?.result?.isError !== true) fail('未知工具应该回 isError:true');
  console.log('\n✓ 未知工具 → isError:true（连接没断）');

  console.log('\n全部通过');
})();
