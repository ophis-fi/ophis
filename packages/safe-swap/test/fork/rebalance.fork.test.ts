/**
 * M2 fork integration test (env-gated; NOT run in CI).
 *
 * Proves that the batch buildOphisSafePresign produces, executed by the
 * @ophis/safe-swap executor via protocol-kit, has the correct EFFECTS against the
 * REAL deployed Ophis/CoW + Safe contracts on an OP mainnet fork:
 *   1. approve sets EXACTLY pullAmount to the real Ophis relayer (never MaxUint).
 *   2. setPreSignature records the order in the REAL GPv2Settlement (so a solver could settle).
 *   3. the relayer can pull EXACTLY pullAmount from the Safe and no more (allowance exhausted).
 *   4. the signed order's receiver is the Safe.
 *
 * NOTE ON SCOPE: a local fork has NO CoW solver network, so an end-to-end solver
 * settlement (and thus the exact partner-fee transfer to 0x858…CeF8) cannot be
 * reproduced here without hand-building a solver's settle() call. That end-to-end
 * behaviour is validated by M4's monitored real-chain rollout. This test proves
 * every on-chain effect the builder + executor actually control.
 *
 * Run: OPHIS_FORK_RPC=https://mainnet.optimism.io pnpm --filter @ophis/safe-swap test:fork
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, type Address } from 'viem';
import { assembleVaultOrder, buildPresignTxBatch, computeOrderUid, ORDER_TTL_SECONDS } from '../../src/order.js';
import { executeOphisSafePresign } from '../../src/exec-safe.js';
import {
  ANVIL_PK,
  dealErc20,
  deploySafe,
  ERC20_ABI,
  impersonate,
  PRE_SIGNED,
  SETTLEMENT_ABI,
  startFork,
  type Fork,
} from './harness.js';

// One entry per self-hosted Ophis chain. Each runs only when its fork RPC env is set.
const CHAINS = [
  {
    name: 'OP',
    id: 10,
    rpcEnv: 'OPHIS_FORK_RPC',
    port: 8551,
    usdc: getAddress('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
    weth: getAddress('0x4200000000000000000000000000000000000006'),
    settlement: getAddress('0x310784c7FCE12d578dA6f53460777bAc9718B859'),
    relayer: getAddress('0x83847EaB41ad9ea43809ce71569eB2e9daF51830'),
  },
  {
    name: 'Unichain',
    id: 130,
    rpcEnv: 'OPHIS_FORK_RPC_UNICHAIN',
    port: 8552,
    usdc: getAddress('0x078D782b760474a361dDA0AF3839290b0EF57AD6'),
    weth: getAddress('0x4200000000000000000000000000000000000006'),
    settlement: getAddress('0x108A678716e5E1776036eF044CAB7064226F714E'),
    relayer: getAddress('0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb'),
  },
  {
    // Base is CoW-HOSTED: the SDK resolves the CANONICAL GPv2 settlement + relayer
    // (fee still rides in appData). Verifies the canonical-settlement presign path.
    name: 'Base',
    id: 8453,
    rpcEnv: 'OPHIS_FORK_RPC_BASE',
    port: 8553,
    usdc: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    weth: getAddress('0x4200000000000000000000000000000000000006'),
    settlement: getAddress('0x9008D19f58AAbD9eD0D60971565AA8510560ab41'),
    relayer: getAddress('0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'),
  },
] as const;

describe.each(CHAINS)('rebalance fork integration ($name)', (c) => {
  const rpc = process.env[c.rpcEnv];
  const CHAIN = c.id;
  const USDC = c.usdc;
  const WETH = c.weth;
  const OP_SETTLEMENT = c.settlement;
  const OP_RELAYER = c.relayer;

  let fork: Fork;
  let safe: Address;

  beforeAll(async () => {
    if (!rpc) return;
    fork = await startFork(rpc, c.port);
    safe = await deploySafe(fork, BigInt(Date.now()));
    await dealErc20(fork, USDC, safe, 5_000_000n); // 5 USDC
  }, 90_000);

  afterAll(() => fork?.stop());

  it.runIf(rpc)('executes [approve, setPreSignature] with the correct on-chain effects', async () => {
    // Build the order from a plausible CoW sell quote (net + fee split), then the batch.
    const order = assembleVaultOrder({
      safe,
      quoteSellToken: USDC,
      quoteBuyToken: WETH,
      quoteSellAmount: '999000', // net
      quoteFeeAmount: '1000', // fee -> gross 1_000_000
      quoteBuyAmount: '250000000000000', // ~0.00025 WETH floor
      requestedSellToken: USDC,
      requestedBuyToken: WETH,
      requestedGross: 1_000_000n,
      appDataHash: `0x${'ab'.repeat(32)}`,
      slippageBps: 50,
      ttlSeconds: ORDER_TTL_SECONDS,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    // (4) receiver is the Safe.
    expect(order.receiver.toLowerCase()).toBe(safe.toLowerCase());
    expect(order.feeAmount).toBe('0');
    expect(order.sellAmount).toBe('1000000');

    const orderUid = computeOrderUid(order, CHAIN, safe);
    const pullAmount = BigInt(order.sellAmount) + BigInt(order.feeAmount);
    const { txs, settlement, relayer } = buildPresignTxBatch({
      chainId: CHAIN,
      orderUid,
      sellToken: order.sellToken,
      pullAmount,
      currentAllowance: 0n,
    });
    expect(settlement.toLowerCase()).toBe(OP_SETTLEMENT.toLowerCase());
    expect(relayer.toLowerCase()).toBe(OP_RELAYER.toLowerCase());

    // Execute the batch AS the Safe via the protocol-kit executor.
    const res = await executeOphisSafePresign({ provider: fork.rpcUrl, signer: ANVIL_PK, safe, txs });
    expect(res.executed).toBe(true);
    expect(res.threshold).toBe(1);

    // (1) exact allowance to the real relayer.
    const allowance = await fork.pub.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [safe, OP_RELAYER],
    });
    expect(allowance).toBe(1_000_000n);

    // (2) presignature recorded in the REAL settlement contract.
    const pre = await fork.pub.readContract({
      address: OP_SETTLEMENT,
      abi: SETTLEMENT_ABI,
      functionName: 'preSignature',
      args: [orderUid],
    });
    expect(pre).toBe(PRE_SIGNED);

    // (3) end-to-end corroboration: the real settlement path (relayer transferFrom) pulls
    // EXACTLY pullAmount, then a further 1-wei pull reverts. The allowance() == pullAmount
    // assertion above is the definitive exact-approve proof; this shows it being consumed.
    await impersonate(fork, OP_RELAYER);
    const settBalBefore = await fork.pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [OP_SETTLEMENT] });
    const pullHash = await fork.wallet.sendTransaction({
      account: OP_RELAYER,
      chain: null,
      to: USDC,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transferFrom', args: [safe, OP_SETTLEMENT, pullAmount] }),
    });
    await fork.pub.waitForTransactionReceipt({ hash: pullHash });
    const settBalAfter = await fork.pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [OP_SETTLEMENT] });
    expect(settBalAfter - settBalBefore).toBe(1_000_000n);

    // A further 1-wei pull reverts because the exact allowance is now exhausted (with a
    // MaxUint approve it would have succeeded). The Safe still holds 4 USDC, so this
    // isolates allowance, not balance.
    await expect(
      fork.pub.call({
        account: OP_RELAYER,
        to: USDC,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transferFrom', args: [safe, OP_SETTLEMENT, 1n] }),
      }),
    ).rejects.toThrow();
  }, 120_000);
});
