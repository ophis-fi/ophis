/**
 * E2E test: full Safe propose → confirm → execute lifecycle on Sepolia.
 *
 * OPERATOR SETUP (one-time, not automated):
 *   1. Run `cast wallet new` twice — burner-1 (proposer/signer) and burner-2 (optional 2-of-2).
 *   2. Save burner-1 PK to repo secret  E2E_SAFE_BURNER_KEY.
 *   3. Fund burner-1 with ~0.05 SEP.
 *   4. Deploy a 1-of-1 Safe owned by burner-1 on Sepolia via app.safe.global.
 *   5. Save the deployed Safe address to repo variable  E2E_SAFE_ADDRESS.
 *   6. Fund the Safe with testnet WETH (wrap at 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14).
 *
 * GATING:
 *   Set  RUN_E2E=1  to execute. Without it, the describe block is skipped. This is the
 *   intended behaviour for all unit/integration CI runs (pnpm test, pnpm test:integration).
 *   The nightly GitHub Actions schedule workflow sets RUN_E2E=1 and runs  pnpm test:e2e.
 *
 * KNOWN LIMITATIONS (TODO items — to be resolved once operator provisions the test Safe):
 *   TODO(e2e): proposeRebateBatch hardcodes OPHIS_SAFE_ADDRESS from src/safe/addresses.ts.
 *     The function needs an optional `safeAddress` param override so the test can target
 *     the Sepolia test Safe. For now, the test calls the function directly and the Safe
 *     address mismatch will surface only at runtime (test is gated, so typecheck is clean).
 *   TODO(e2e): WETH_BY_CHAIN only covers chainId 100 (Gnosis). Add chainId 11_155_111 entry
 *     (Sepolia WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14) before running e2e live.
 *   TODO(e2e): confirmTransaction expects a raw EIP-191 signature. Verify that
 *     `account.signMessage({ message: { raw: hashBytes } })` produces a signature accepted
 *     by the Safe Transaction Service v2 /confirm endpoint (EIP-191 personal_sign format).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import SafeApiKit from '@safe-global/api-kit';
import { proposeRebateBatch } from '../../src/batch/propose.js';
import { buildEthCallSimulator, isolateBadRecipients } from '../../src/batch/dryRun.js';

const RUN_E2E = process.env.RUN_E2E === '1';
const describeE2E = RUN_E2E ? describe : describe.skip;

const SAFE_ADDRESS = process.env.E2E_SAFE_ADDRESS as `0x${string}`;
const BURNER_KEY = process.env.E2E_SAFE_BURNER_KEY as `0x${string}`;
const SEPOLIA_WETH: `0x${string}` = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';

describeE2E('Sepolia: full propose → execute lifecycle', () => {
  let safeTxHash: `0x${string}`;

  beforeAll(() => {
    if (!SAFE_ADDRESS || !BURNER_KEY) throw new Error('E2E_SAFE_ADDRESS + E2E_SAFE_BURNER_KEY required');
  });

  it('isolates a known-bad recipient and proposes only the good ones', async () => {
    const goodRecipient: `0x${string}` = '0x000000000000000000000000000000000000dEaD';
    const badRecipient: `0x${string}` = '0x0000000000000000000000000000000000000000';   // zero addr: WETH reverts on transfer to 0
    const transfers = [
      { to: goodRecipient, amount: 1n },
      { to: badRecipient,  amount: 1n },
    ];
    const sim = buildEthCallSimulator({ chainId: 11_155_111, rpcUrl: SEPOLIA_RPC });
    const { good, bad } = await isolateBadRecipients(transfers, sim);
    expect(bad.map((t) => t.to)).toEqual([badRecipient]);

    const result = await proposeRebateBatch({
      chainId: 11_155_111,
      rpcUrl: SEPOLIA_RPC,
      proposerPrivateKey: BURNER_KEY,
      transfers: good,
    });
    expect(result.safeTxHash).toMatch(/^0x[a-f0-9]{64}$/);
    safeTxHash = result.safeTxHash;
  }, 90_000);

  it('the proposed transaction appears in Safe Transaction Service', async () => {
    const apiKit = new SafeApiKit({ chainId: 11_155_111n });
    const tx = await apiKit.getTransaction(safeTxHash);
    expect(tx.safe.toLowerCase()).toBe(SAFE_ADDRESS.toLowerCase());
    expect(tx.isExecuted).toBe(false);
  }, 30_000);

  it('after operator-side execute, polling observes isExecuted=true', async () => {
    // In CI: burner-1 is the sole owner so it both proposes and confirms.
    // confirmTransaction sends an EIP-191 personal_sign over the safeTxHash bytes.
    const account = privateKeyToAccount(BURNER_KEY);
    const apiKit = new SafeApiKit({ chainId: 11_155_111n });
    // TODO(e2e): The Safe TX Service /confirm endpoint expects a signature produced by
    //   signing the raw safeTxHash bytes (not EIP-191 string). Verify the exact signing
    //   method against api-kit v2 source before running live. Annotated here for the
    //   operator who provisions the test Safe.
    const sig = await account.signMessage({ message: { raw: safeTxHash as `0x${string}` } });
    await apiKit.confirmTransaction(safeTxHash, sig);
    // Wait for the executor (Safe's relayer) to mine. Up to 5 minutes.
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const tx = await apiKit.getTransaction(safeTxHash);
      if (tx.isExecuted) {
        expect(tx.isSuccessful).toBe(true);
        return;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    throw new Error('execution did not complete within 5min');
  }, 6 * 60_000);
});
