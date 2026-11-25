import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { preparePayout } from '../../../infra/solana/mainnet/prepare-payout.mjs';
import { getCreateSettlementOwnedOrderInstructionDataDecoder } from '../dist/settlement/generated/instructions/createSettlementOwnedOrder.js';
import { getWithdrawNativeSolInstructionDataDecoder } from '../dist/settlement/generated/instructions/withdrawNativeSol.js';
import profile from '../../../apps/solana/deployment.mainnet.json' with { type: 'json' };
const source = 'So11111111111111111111111111111111111111112',
  target = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
test('payouts pin the signed destination, authority and minimum to the configured deployment', async () => {
  const plan = await preparePayout(['native', '70000']);
  const [ix] = plan.instructions;
  assert.equal(ix.program, profile.programId);
  assert.equal(ix.accounts[1].address, profile.authorities.settlementOwnedOrderAuthority);
  assert.equal(ix.accounts[3].address, profile.treasuryWallet);
  assert.equal(
    getWithdrawNativeSolInstructionDataDecoder().decode(Buffer.from(ix.dataBase64, 'base64'))
      .amount,
    70000n,
  );
  const expiry = String(Math.floor(Date.now() / 1000) + 600);
  const spl = await preparePayout(['spl', source, target, '400', '380', expiry]);
  const [ata, order] = spl.instructions;
  const destination = (
    await findAssociatedTokenPda({
      owner: profile.treasuryWallet,
      mint: target,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
  )[0];
  assert.equal(ata.accounts[1].address, destination);
  assert.equal(order.program, profile.programId);
  const { intent } = getCreateSettlementOwnedOrderInstructionDataDecoder().decode(
    Buffer.from(order.dataBase64, 'base64'),
  );
  assert.equal(intent.owner, order.accounts[2].address);
  assert.equal(intent.buyTokenAccount, destination);
  assert.equal(intent.sellAmount, 400n);
  assert.equal(intent.buyAmount, 380n);
  await assert.rejects(preparePayout(['spl', source, target, '400', '0', expiry]));
  await assert.rejects(preparePayout(['spl', source, target, '400', '380', '1']));
  await assert.rejects(preparePayout(['native', '18446744073709551616']));
});
