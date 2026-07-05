import { getMultiSendCallOnlyDeployment } from '@safe-global/safe-deployments';

/**
 * Ophis partner-fee Safe. CREATE2-deterministic across all 10 CoW chains.
 * SOURCE OF TRUTH for downstream sanity checks: packages/sdk/src/partner-fee.ts.
 */
export const OPHIS_SAFE_ADDRESS = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' as const;

/** Bridged Ethereum WETH on Gnosis Chain. */
export const WETH_GNOSIS: `0x${string}` = '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1';

/** OP-stack canonical WETH predeploy - identical on every OP-stack chain (Optimism 10,
 *  Unichain 130). Used by the sovereign own-fee payout MultiSend. */
export const WETH_OP_STACK: `0x${string}` = '0x4200000000000000000000000000000000000006';

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
  // Sovereign own-fee payout chains (migration 0017): the OP-stack WETH predeploy.
  10: WETH_OP_STACK, // Optimism
  130: WETH_OP_STACK, // Unichain
};

/**
 * Explicit Safe Transaction Service base URL for chains @safe-global/api-kit does NOT
 * ship a built-in URL for. The api-kit's TRANSACTION_SERVICE_URLS table (v2.5) covers
 * Gnosis (100) and Optimism (10) but NOT Unichain (130), so `new SafeApiKit({ chainId:
 * 130n })` THROWS with "no transaction service available for chainId 130". Pass the
 * returned URL as `txServiceUrl` for 130. Returns undefined for every chain the api-kit
 * already knows, so those keep the built-in behavior untouched.
 *
 * The Unichain URL mirrors apps/frontend/libs/core/src/gnosisSafe/index.ts
 * (SAFE_TRANSACTION_SERVICE_URL[130] = 'https://safe-transaction-unichain.safe.global/api'),
 * and matches the api-kit's own naming scheme for the other chains
 * ('https://safe-transaction-<chain>.safe.global/api'). Env-overridable to match the
 * cow-client / balances convention.
 */
export function safeTxServiceUrl(chainId: number): string | undefined {
  if (chainId === 130) {
    return process.env.SAFE_TX_SERVICE_UNICHAIN ?? 'https://safe-transaction-unichain.safe.global/api';
  }
  return undefined;
}

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
