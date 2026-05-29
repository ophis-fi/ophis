import { COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS, COW_PROTOCOL_VAULT_RELAYER_ADDRESS } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

/**
 * Ophis (2026-05-25): reject custom hooks whose call `target` is a
 * protocol-critical contract — the CoW Settlement or VaultRelayer.
 *
 * Defense-in-depth: user pre/post hooks execute via the isolated
 * HooksTrampoline, so they cannot wield Settlement/VaultRelayer authority
 * at the contract level. Targeting those addresses directly is never a
 * legitimate hook — it can only cause settlement reverts / wasted gas — so
 * this blocks a phishing hook-dapp (or a user typo in BuildHookApp) from
 * constructing one. Closes audit finding L3 (2026-05-19 Phase 3).
 *
 * Returns a human-readable error if the target is forbidden on the given
 * chain, otherwise null.
 */
export function getForbiddenHookTargetError(target: string | undefined, chainId: SupportedChainId): string | null {
  if (!target) return null

  const normalized = target.trim().toLowerCase()
  if (!normalized) return null

  const protocolContracts: ReadonlyArray<[string | undefined, string]> = [
    [COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[chainId], 'Ophis Settlement'],
    [COW_PROTOCOL_VAULT_RELAYER_ADDRESS[chainId], 'Ophis VaultRelayer'],
  ]

  for (const [address, name] of protocolContracts) {
    if (address && address.toLowerCase() === normalized) {
      return `A hook cannot target the ${name} contract`
    }
  }

  return null
}
