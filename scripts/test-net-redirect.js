'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { openStream } = require('../lib/net');

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/secret' });
      return res.end();
    }
    res.writeHead(200, { 'content-length': '6' });
    res.end('secret');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const seen = [];

  try {
    await assert.rejects(
      openStream(`http://127.0.0.1:${port}/start`, {
        validateUrl: async (url) => {
          seen.push(url);
          if (url.endsWith('/secret')) throw new Error('private redirect blocked');
        },
        timeout: 3000,
      }),
      /private redirect blocked/
    );
    assert.deepEqual(seen.map((url) => new URL(url).pathname), ['/start', '/secret']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('redirect validation passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
