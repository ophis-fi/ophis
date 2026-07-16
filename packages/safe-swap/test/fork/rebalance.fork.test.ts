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

// All CoW-hosted (canonical) chains share the deterministic GPv2 settlement + relayer;
// only the fundable sell token + fork RPC differ. `usdc` is just the sell token (WXDAI on
// Gnosis). Each entry runs only when its fork RPC env is set.
const CANON_SETTLEMENT = getAddress('0x9008d19f58aabd9ed0d60971565aa8510560ab41');
const CANON_RELAYER = getAddress('0xc92e8bdf79f0507f65a392b0ab4667716bfe0110');

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
  // --- CoW-hosted (canonical settlement, fee via appData) ---
  {
    name: 'Base',
    id: 8453,
    rpcEnv: 'OPHIS_FORK_RPC_BASE',
    port: 8553,
    usdc: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    weth: getAddress('0x4200000000000000000000000000000000000006'),
    settlement: CANON_SETTLEMENT,
    relayer: CANON_RELAYER,
  },
  {
    name: 'Ethereum',
    id: 1,
    rpcEnv: 'OPHIS_FORK_RPC_ETH',
    port: 8554,
    usdc: getAddress('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
    weth: getAddress('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
    settlement: CANON_SETTLEMENT,
    relayer: CANON_RELAYER,
  },
  {
    name: 'Arbitrum',
    id: 42161,
    rpcEnv: 'OPHIS_FORK_RPC_ARBITRUM',
    port: 8555,
    usdc: getAddress('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
    weth: getAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1'),
    settlement: CANON_SETTLEMENT,
    relayer: CANON_RELAYER,
  },
  {
    name: 'Polygon',
    id: 137,
    rpcEnv: 'OPHIS_FORK_RPC_POLYGON',
    port: 8556,
    usdc: getAddress('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'),
    weth: getAddress('0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270'), // WPOL
    settlement: CANON_SETTLEMENT,
    relayer: CANON_RELAYER,
  },
  {
    name: 'Gnosis',
    id: 100,
    rpcEnv: 'OPHIS_FORK_RPC_GNOSIS',
    port: 8557,
    usdc: getAddress('0xe91d153e0b41518a2ce8dd3d7944fa863463a97d'), // WXDAI (sell)
    weth: getAddress('0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1'), // WETH on Gnosis
    settlement: CANON_SETTLEMENT,
    relayer: CANON_RELAYER,
  },
  {
    name: 'Avalanche',
    id: 43114,
    rpcEnv: 'OPHIS_FORK_RPC_AVAX',
    port: 8558,
    usdc: getAddress('0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'),
    weth: getAddress('0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7'), // WAVAX
    settlement: CANON_SETTLEMENT,
    relayer: CANON_RELAYER,
  },
  {
    name: 'BNB',
    id: 56,
    rpcEnv: 'OPHIS_FORK_RPC_BNB',
    port: 8559,
    usdc: getAddress('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'),
    weth: getAddress('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'), // WBNB
    settlement: CANON_SETTLEMENT,
    relayer: CANON_RELAYER,
  },
  {
    name: 'Linea',
    id: 59144,
    rpcEnv: 'OPHIS_FORK_RPC_LINEA',
    port: 8560,
    usdc: getAddress('0x176211869ca2b568f2a7d4ee941e073a821ee1ff'),
    weth: getAddress('0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f'),
    settlement: CANON_SETTLEMENT,
    relayer: CANON_RELAYER,
  },
  // Ink (57073) + Plasma (9745) are also SDK-supported (canonical CoW settlement, identical
  // presign path). Not fork-verified here only because their native-USDC address + a reliable
  // archive fork RPC weren't pinned down; add a fundable sell token + rpcEnv to verify them.
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
