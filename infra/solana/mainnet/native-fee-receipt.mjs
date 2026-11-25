// Reconcile a dedicated native SOL withdrawal from a trusted finalized RPC export.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import mainnet from '../../../apps/solana/deployment.mainnet.json' with { type: 'json' };
import {
  findNativeSolBufferPda,
  findStatePda,
} from '../../../packages/solana-sdk/dist/settlement/generated/pdas/index.js';
import { getWithdrawNativeSolInstructionDataDecoder } from '../../../packages/solana-sdk/dist/settlement/generated/instructions/withdrawNativeSol.js';

const kit = createRequire(new URL('../../../packages/solana-sdk/package.json', import.meta.url))(
  '@solana/kit',
);
const args = process.argv.slice(2);
if (args.length !== 2 && args.length !== 4)
  throw Error('Usage: node native-fee-receipt.mjs [PROGRAM TREASURY_WALLET] SIGNATURE RECEIPT.json');
const [program, wallet, signature, file] =
  args.length === 2 ? [mainnet.programId, mainnet.treasuryWallet, ...args] : args;
const programAddress = kit.address(program);
const treasury = kit.address(wallet);
kit.signature(signature);
const exportData = JSON.parse(readFileSync(file, 'utf8'), (_key, value, context) =>
  typeof value === 'number' && !Number.isSafeInteger(value) ? BigInt(context.source) : value,
);
const { transaction: tx, status } = exportData;
assert.equal(exportData.signature, signature);
assert.equal(tx.transaction.signatures[0], signature);
assert.equal(status.confirmationStatus, 'finalized');
assert.equal(status.slot, tx.slot);
assert.equal(status.err, null);
assert.equal(tx.meta.err, null);
const [state] = await findStatePda({ programAddress });
const [buffer] = await findNativeSolBufferPda({ programAddress });
const { message } = tx.transaction;
const keys = message.accountKeys;
assert.ok(!message.addressTableLookups?.length && new Set(keys).size === keys.length);
keys.forEach(kit.address);
assert.ok(treasury !== buffer && buffer !== keys[0] && treasury !== state);
const instructions = message.instructions.filter((ix) => {
  if (keys[ix.programIdIndex] !== 'ComputeBudget111111111111111111111111111111') return true;
  assert.equal(ix.accounts.length, 0);
  return false;
});
assert.equal(instructions.length, 1);
const [ix] = instructions;
assert.equal(keys[ix.programIdIndex], program);
const [stateIndex, authorityIndex, bufferIndex, treasuryIndex] = ix.accounts;
assert.deepEqual(
  [keys[stateIndex], keys[bufferIndex], keys[treasuryIndex]],
  [state, buffer, treasury],
);
assert.equal(ix.accounts.length, 4);
assert.ok(
  Number.isInteger(authorityIndex) &&
    authorityIndex >= 0 &&
    authorityIndex < message.header.numRequiredSignatures,
);
const data = kit.getBase58Encoder().encode(ix.data);
assert.ok(data.length === 9 && data[0] === 12);
const maxLamports = getWithdrawNativeSolInstructionDataDecoder().decode(data).amount;
const { preBalances, postBalances } = tx.meta;
assert.equal(preBalances.length, keys.length);
assert.equal(postBalances.length, keys.length);
const debited = BigInt(preBalances[bufferIndex]) - BigInt(postBalances[bufferIndex]);
assert.ok(debited >= 0n && debited <= maxLamports);
const fee = BigInt(tx.meta.fee);
for (let i = 0; i < keys.length; i++) {
  const expected =
    (i === treasuryIndex ? debited : 0n) -
    (i === bufferIndex ? debited : 0n) -
    (i === 0 ? fee : 0n);
  assert.equal(BigInt(postBalances[i]) - BigInt(preBalances[i]), expected);
}
console.log(
  JSON.stringify({
    signature,
    slot: String(tx.slot),
    treasury,
    buffer,
    maxLamports: String(maxLamports),
    receivedLamports: String(debited),
    networkFeeLamports: String(fee),
    payer: keys[0],
  }),
);
