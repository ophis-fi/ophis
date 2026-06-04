import { getMultiSendCallOnlyDeployment } from '@safe-global/safe-deployments';

/**
 * Ophis partner-fee Safe. CREATE2-deterministic across all 10 CoW chains.
 * SOURCE OF TRUTH for downstream sanity checks: packages/sdk/src/partner-fee.ts.
 */
export const OPHIS_SAFE_ADDRESS = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' as const;

/** Bridged Ethereum WETH on Gnosis Chain. */
export const WETH_GNOSIS: `0x${string}` = '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1';

/**
 * Resolve Safe MultiSendCallOnly v1.4.1 address for a chain.
 *
 * Why CallOnly: Safe MultiSend (without CallOnly) supports DELEGATECALL in inner
 * txs. A buggy or malicious inner DELEGATECALL can drain the Safe. We do not need
 * inner DELEGATECALLs (ours are pure WETH.transfer calls), so we use the
 * call-only variant for defense-in-depth.
 *
 * The outer Safe transaction still uses operation=1 (DELEGATECALL) to invoke the
 * MultiSendCallOnly contract — that's standard Safe-MultiSend pattern.
 */
export function multiSendCallOnlyAddress(chainId: number): `0x${string}` {
  const dep = getMultiSendCallOnlyDeployment({ version: '1.4.1', network: String(chainId) });
  if (!dep) throw new Error(`no MultiSendCallOnly v1.4.1 deployment for chain ${chainId}`);
  const addr = dep.networkAddresses[String(chainId)];
  if (!addr) throw new Error(`MultiSendCallOnly v1.4.1 has no address for chain ${chainId}`);
  return addr as `0x${string}`;
}

export const WETH_BY_CHAIN: Readonly<Record<number, `0x${string}`>> = {
  100: WETH_GNOSIS,
  // Future chains added here as we expand payout reach. Phase 1 = Gnosis only.
};

/**
 * Optional revenue/treasury address for the direct-rebate model
 * (REBATE_DIRECT_MODE). When set, the batcher sweeps the un-rebated remainder
 * (F - Σrebates) of the fee Safe's WETH here in the same multisend each cycle,
 * so Ophis's retained margin is removed from the fee Safe and is NOT re-counted
 * (and partially re-rebated) the next cycle. Unset => the remainder stays in the
 * fee Safe (documented re-rebate caveat — only sensible for testing the direct
 * distribution before a treasury address is chosen). A malformed value fails
 * closed (throws) rather than silently skipping retention.
 *
 * It must be an Ophis-controlled address that accepts ERC20 WETH (an EOA or a
 * Safe); a contract that reverts on receipt is caught by the batcher's pre-
 * proposal dry-run.
 */
export function getRevenueAddress(): `0x${string}` | null {
  const raw = process.env.REBATE_REVENUE_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`REBATE_REVENUE_ADDRESS must be a 0x-prefixed 20-byte hex address; got "${raw}"`);
  }
  return raw as `0x${string}`;
}
