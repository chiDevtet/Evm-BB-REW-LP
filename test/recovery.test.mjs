import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'utility-recovery-'));
process.env.DATA_DIR = temp;
process.env.CONFIRMATIONS = '2';
const { save, read } = await import('../keeper/common.mjs');
const { settle } = await import('../keeper/tx.mjs');
test('journal rebroadcasts identical signed bytes and waits for receipt finality', async () => {
  const calls = [];
  let receipt = null,
    head = 10;
  const p = {
    getNetwork: async () => ({ chainId: 4663n }),
    getTransactionReceipt: async () => receipt,
    broadcastTransaction: async (raw) => calls.push(raw),
    getBlockNumber: async () => head,
  };
  save('pending.json', { chain: '4663', hash: '0x123', raw: 'signed-bytes' });
  assert.equal(await settle(p), false);
  assert.deepEqual(calls, ['signed-bytes']);
  receipt = { status: 1, blockNumber: 10 };
  assert.equal(await settle(p), false);
  assert(read('pending.json'));
  head = 11;
  assert.equal(await settle(p), true);
  assert.equal(read('pending.json'), null);
});
test('journal stops on chain mismatch and reports reverted receipt', async () => {
  save('pending.json', { chain: '4663', hash: '0x123', raw: 'bytes' });
  await assert.rejects(settle({ getNetwork: async () => ({ chainId: 1n }) }), /chain mismatch/);
  await assert.rejects(
    settle({
      getNetwork: async () => ({ chainId: 4663n }),
      getTransactionReceipt: async () => ({ status: 0, blockNumber: 1 }),
      getBlockNumber: async () => 10,
    }),
    /reverted/,
  );
  assert.equal(read('pending.json'), null);
});
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
