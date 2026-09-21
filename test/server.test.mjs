import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('dashboard serves real empty state, public assets, and no data-directory files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utility-http-'));
  const child = spawn(process.execPath, ['keeper/server.mjs'], {
    env: { ...process.env, PORT: '31844', HOST: '127.0.0.1', ENGINE_ADDRESS: '', DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(Error('server exited')));
    });
    const status = await fetch('http://127.0.0.1:31844/api/status');
    assert.deepEqual(await status.json(), {
      configured: false,
      network: 'Robinhood Chain',
      chainId: 4663,
    });
    assert(
      (await (await fetch('http://127.0.0.1:31844/')).text()).includes('Three ways to build.'),
    );
    assert((await (await fetch('http://127.0.0.1:31844/style.css')).text()).includes('@media'));
    assert.equal((await fetch('http://127.0.0.1:31844/data/pending.json')).status, 404);
    assert.equal((await fetch('http://127.0.0.1:31844/api/epochs/abc')).status, 400);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
