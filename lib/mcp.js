'use strict';

/**
 * 零依赖的 MCP（Model Context Protocol）服务端。
 *
 * 为什么要做成 MCP 而不是只给一份 skill：
 *  skill 的前提是「agent 能跑 shell，并且知道服务已经在 8787 上跑着」。
 *  Claude Desktop、Cherry Studio 这类客户端根本没有 shell，skill 在它们那儿等于不存在；
 *  而 MCP 是一份协议，谁都能接。
 *
 * 为什么不是新起一个进程 + stdio：
 *  本机已经有一个 HTTP 服务了，stdio 版本等于把同一套能力抄第二遍，还得让用户去改
 *  客户端配置里的启动命令。这里直接用 MCP 的 Streamable HTTP 传输，
 *  客户端填一个 http://127.0.0.1:8787/mcp 就完事，服务在跑就能用。
 *
 * 只实现 JSON 响应模式（规范允许）：不主动开 SSE 流，每个 POST 回一个 JSON。
 * 工具都是几秒内返回的请求/响应型，没有服务端主动推送的需求。
 */

const MAX_BODY = 1024 * 1024;
// 认识的协议版本。客户端报哪个就回哪个，不认识的回最老的那个（向下兼容最安全）
const KNOWN = ['2024-11-05', '2025-03-26', '2025-06-18'];
const FALLBACK_VERSION = '2024-11-05';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'mcp-session-id',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * @param {object} opts
 * @param {string} opts.name     serverInfo.name
 * @param {string} opts.version
 * @param {string} [opts.instructions]  initialize 时给模型的一段说明
 * @param {Array}  opts.tools    [{ name, description, inputSchema, handler(args) }]
 */
function createMcp({ name, version, instructions = '', tools = [] }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  const toolList = () =>
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));

  async function callTool(name_, args) {
    const t = byName.get(name_);
    if (!t) {
      return { content: [{ type: 'text', text: `没有这个工具：${name_}` }], isError: true };
    }
    try {
      const out = await t.handler(args && typeof args === 'object' ? args : {});
      const text =
        typeof out === 'string' ? out : String(out?.text ?? JSON.stringify(out ?? null, null, 2));
      return { content: [{ type: 'text', text }], isError: Boolean(out && out.isError) };
    } catch (e) {
      // 工具自己报的错（参数不对、上游 500）不该让整个连接断掉，
      // 按 MCP 的约定用 isError 交给模型去解释和重试
      return { content: [{ type: 'text', text: `执行失败：${String(e.message || e)}` }], isError: true };
    }
  }

  /** 返回 { id, result } / { id, error }；通知类返回 null（不回包） */
  async function dispatch(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return rpcError(msg?.id, -32600, 'Invalid Request');
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const want = String(params?.protocolVersion || '');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            // 报一个自己认识的版本；客户端不认识会自己断开，别硬装懂
            protocolVersion: KNOWN.includes(want) ? want : FALLBACK_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            ...(instructions ? { instructions } : {}),
          },
        };
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: toolList() } };

      case 'tools/call': {
        const nm = String(params?.name || '');
        if (!nm) return rpcError(id, -32602, '缺少工具名');
        const result = await callTool(nm, params?.arguments);
        return { jsonrpc: '2.0', id, result };
      }

      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };

      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };

      default:
        // 通知没人收也要静默吞掉，客户端不会为重放通知再发一次请求
        if (isNotification) return null;
        return rpcError(id, -32601, `不支持的方法：${method}`);
    }
  }

  function send(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      ...CORS,
    });
    res.end(text);
  }

  async function handle(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    // 规范里 GET 是给「服务端主动推」用的 SSE 通道，这里没有推送需求，明确拒绝
    if (req.method !== 'POST') {
      res.writeHead(405, { ...CORS, allow: 'POST, OPTIONS', 'content-type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, -32600, '只接受 POST')));
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      send(res, 413, rpcError(null, -32600, String(e.message || e)));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(res, 200, rpcError(null, -32700, 'Parse error'));
      return;
    }

    // batch 在 2025-06-18 里已经删了，但老客户端还会发；这里串行处理并回数组
    if (Array.isArray(msg)) {
      const out = [];
      for (const one of msg) {
        const r = await dispatch(one);
        if (r) out.push(r);
      }
      if (!out.length) {
        res.writeHead(202, CORS);
        res.end();
        return;
      }
      send(res, 200, out);
      return;
    }

    const out = await dispatch(msg);
    if (!out) {
      res.writeHead(202, CORS);
      res.end();
      return;
    }
    send(res, 200, out);
  }

  return { handle, tools: toolList };
}

module.exports = { createMcp };
