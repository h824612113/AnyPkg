'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DownloadQueue } = require('../lib/queue');

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'anypkg-quota-'));
  try {
    const queue = new DownloadQueue({ dir, maxBytes: 8 });
    fs.writeFileSync(path.join(dir, 'existing.apk'), Buffer.alloc(7));
    assert.equal(queue.usage(), 7);
    assert.deepEqual(queue.assertCapacity(), { used: 7, limit: 8 });

    fs.writeFileSync(path.join(dir, '.partial'), Buffer.alloc(1));
    assert.throws(() => queue.add({ url: 'https://example.com/new.apk', name: 'new.apk' }), {
      code: 'download_capacity',
    });
    assert.throws(() => queue.begin({ name: 'external.apk' }), { code: 'download_capacity' });
    assert.equal(queue.list().length, 0, 'rejected downloads must not enter the queue');

    fs.unlinkSync(path.join(dir, '.partial'));
    assert.deepEqual(queue.assertCapacity(), { used: 7, limit: 8 });
    console.log('download quota passed');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
