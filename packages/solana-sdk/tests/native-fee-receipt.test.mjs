import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(
  new URL('../../../infra/solana/mainnet/native-fee-receipt.mjs', import.meta.url),
);
const fixture = fileURLToPath(
  new URL('../../../apps/solana/evidence/native-fee-rpc-export-2026-11-21.json', import.meta.url),
);
const expected = JSON.parse(
  readFileSync(
    new URL('../../../apps/solana/evidence/native-fee-receipt-2026-11-21.json', import.meta.url),
  ),
);
const { programId } = JSON.parse(
  readFileSync(new URL('../../../apps/solana/deployment.local.json', import.meta.url)),
);
const run = (file, wallet = expected.treasury) =>
  JSON.parse(
    execFileSync(process.execPath, [tool, programId, wallet, expected.signature, file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
test('native SOL reports the actual finalized debit with a separate treasury', () => {
  assert.equal(run(fixture).receivedLamports, expected.receivedLamports);
  assert.ok(BigInt(expected.maxLamports) > BigInt(expected.receivedLamports));
  assert.throws(() => run(fixture, expected.payer));
});
test('native receipt rejects unfinalized, unsuccessful and inconsistent balance exports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ophis-native-receipt-'));
  const file = join(dir, 'receipt.json');
  try {
    for (const change of [
      (x) => {
        x.status.confirmationStatus = 'confirmed';
      },
      (x) => {
        x.transaction.meta.err = 'failed';
      },
      (x) => {
        const meta = x.transaction.meta;
        meta.postBalances[0] = JSON.rawJSON(String(BigInt(meta.postBalances[0].rawJSON) + 1n));
      },
    ]) {
      const data = JSON.parse(readFileSync(fixture), (_key, v, context) =>
        typeof v === 'number' && !Number.isSafeInteger(v) ? JSON.rawJSON(context.source) : v,
      );
      change(data);
      writeFileSync(file, JSON.stringify(data));
      assert.throws(() => run(file));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
