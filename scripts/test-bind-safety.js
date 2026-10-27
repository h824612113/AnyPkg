'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function start(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) break;
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
      return { child, port, get output() { return output; } };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('close', resolve));
  return { child, port, output };
}

async function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 1200);
    child.on('close', (code) => resolve({ code, output }));
    child.on('close', () => clearTimeout(timer));
  });
}

async function main() {
  const blocked = await run({ HOST: '0.0.0.0', ANYPKG_ALLOW_INSECURE_REMOTE: '' });
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.output, /非回环地址|ANYPKG_REMOTE_TOKEN/);

  const token = 'test-remote-token-0123456789-abcdef';
  const started = await start({ HOST: '0.0.0.0', ANYPKG_REMOTE_TOKEN: token });
  assert.equal(started.child.exitCode, null, started.output);
  try {
    const base = `http://127.0.0.1:${started.port}`;
    const denied = await fetch(`${base}/api/health`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(allowed.status, 200);

    const mcpDenied = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(mcpDenied.status, 401);
    const mcpAllowed = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(mcpAllowed.status, 200);

    const bootstrap = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    assert.equal(bootstrap.status, 303);
    assert.match(bootstrap.headers.get('set-cookie'), /HttpOnly/);
    const cookieHealth = await fetch(`${base}/api/health`, {
      headers: { cookie: bootstrap.headers.get('set-cookie').split(';')[0] },
    });
    assert.equal(cookieHealth.status, 200);
  } finally {
    started.child.kill('SIGTERM');
    await new Promise((resolve) => started.child.once('close', resolve));
  }
  console.log('bind safety passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
