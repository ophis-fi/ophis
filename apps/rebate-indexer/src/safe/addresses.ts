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
 * CoW Protocol contracts — canonical CREATE2 deployments, IDENTICAL on every CoW
 * chain (incl. Gnosis). Used by the #360 fee-conversion flow (convert.ts):
 *   - GPV2_SETTLEMENT: `setPreSignature(orderUid, true)` makes a pre-signed order
 *     valid so solvers can fill it.
 *   - GPV2_VAULT_RELAYER: pulls the sell token at settlement, so the Safe must
 *     `approve(VaultRelayer, sellAmount)` the token being converted.
 * Verify against https://docs.cow.fi/cow-protocol/reference/contracts/core before
 * adding any non-canonical chain.
 */
export const GPV2_SETTLEMENT = '0x9008D19f58AABD9eD0D60971565AA8510560ab41' as const;
export const GPV2_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as const;
