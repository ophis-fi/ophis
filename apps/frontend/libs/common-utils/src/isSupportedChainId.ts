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
const OPHIS_EXTRA_CHAINS = new Set<number>([10])

export function isSupportedChainId(chainId: number | undefined): chainId is SupportedChainId {
  return typeof chainId === 'number' && (chainId in SupportedChainId || OPHIS_EXTRA_CHAINS.has(chainId))
}
