import { SupportedChainId } from '@cowprotocol/cow-sdk'

// Ophis fork: Optimism (10) is treated as a primary supported chain at the
// frontend layer even though the SDK exposes it as AdditionalTargetChainId,
// not as a SupportedChainId entry.
//
// MegaETH (4326) and HyperEVM (999) were removed in PR #167 (2026-05-21).
// They were briefly listed here too; the P0 hotfix follow-up (PR #234,
// 2026-05-22) removed them because keeping them caused an `Array.find(c =>
// c.id === chainId).id` crash inside wagmi's `getClient` factory: any
// persisted localStorage with `chainId: 4326|999` would hydrate, then
// wagmi's runtime chains array (correctly limited per PR #232 to the new
// FE list) had no matching entry → `find()` returned undefined → `.id`
// threw → entire SPA crashed at boot with "Cannot read properties of
// undefined (reading 'id')".
// Unichain (130) is included too. SAFE because, unlike the removed 4326/999, it
// HAS a matching entry in the wagmi runtime chains array (wagmi/config.ts -> the
// viem `unichain` chain), so wagmi's getClient `find(c => c.id === 130)` resolves
// and cannot re-trigger the PR #234 boot crash. Restores auto network-switch for
// limit/advanced orders + cross-chain selector balances on Unichain.
const OPHIS_EXTRA_CHAINS = new Set<number>([10, 130])

export function isSupportedChainId(chainId: number | undefined): chainId is SupportedChainId {
  return typeof chainId === 'number' && (chainId in SupportedChainId || OPHIS_EXTRA_CHAINS.has(chainId))
}
