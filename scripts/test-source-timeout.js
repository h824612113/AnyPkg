'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { smartText } = require('../lib/net');
const { runSource } = require('../server');

async function main() {
  let closed = false;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    req.on('close', () => {
      closed = true;
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/slow`;

  try {
    const result = await runSource(
      'test',
      () => smartText(url, { prefer: 'direct', hardPrefer: true, noFallback: true, timeout: 60000 }),
      60
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /超时/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(closed, true, 'source timeout should close the underlying response');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('source timeout cancellation passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
