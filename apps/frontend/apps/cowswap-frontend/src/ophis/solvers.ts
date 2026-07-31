/**
 * Static solver registry for Ophis-operated (sovereign) chains.
 *
 * The CoW CMS at cow.fi knows nothing about the solvers competing on the
 * self-hosted Optimism orderbook, so `useSolversInfo` returns an empty map
 * there and every "N solvers" surface (order progress bar ladder, solver
 * competition row) silently degrades. This registry is the static fallback:
 * `useSolversInfo` merges it in wherever the CMS has no entry for a solver id
 * (CMS wins on collision), which makes the existing ladder work on chain 10
 * with zero progress-bar changes.
 *
 * MIRROR INVARIANT: the per-chain solver ids below MUST stay in sync with the
 * `[[drivers]] name = "..."` entries in each stack's AUTOPILOT config, e.g.
 * `infra/optimism-mainnet/configs/autopilot.toml`. Guarded by
 * `scripts/check-solver-registry-invariant.sh` (security.yml hard gate) plus
 * the jest mirror test in `solvers.test.ts`. Update both sides in the same PR.
 *
 * THE AUTOPILOT, NOT driver.toml.tmpl. A lane can exist in the driver config and
 * still never compete: only the autopilot dispatches auctions. On 2026-07-30 OP's
 * driver.toml.tmpl listed 9 lanes while autopilot.toml declared 4, so the shipped
 * "up to N solvers" row claimed 9 when odos, enso, openocean and dodo could not
 * receive an auction at all. Verified against the live orderbook at the time:
 * deployed commit 45c1c7e0b3, autopilot drivers baseline/okx/kyberswap/velora,
 * and auction 2239975 returned solutions from a subset of exactly those.
 *
 * DISPLAY-ALIAS LAYER: `solverId` is INTERNAL ONLY (mirrors the driver config,
 * drives CMS matching and attribution). It is NEVER rendered as-is. User-facing
 * strings come from `ophisSolverPublicLabel` / `ophisSolverPublicDescription`,
 * which neutralize every non-Ophis (third-party aggregator) brand: Ophis public
 * copy never names a competitor (standing copy rule). Only the Ophis-run
 * baseline solver keeps a plain, non-brand label.
 *
 * Counts derived from this registry are phrased "up to N": being dispatched an
 * auction does not guarantee a solver returns a solution for it.
 */

/** Chain id of the Ophis-operated Optimism orderbook. */
export const OPHIS_SOLVER_REGISTRY_CHAIN_ID = 10
export const OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID = 130
export const OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID = 4663

export interface OphisStaticSolverInfo {
  /**
   * Lowercase id, byte-identical to the autopilot `[[drivers]] name`. Internal
   * only: used for CMS matching and attribution, never rendered as a public label.
   */
  solverId: string
  /** Chains (sovereign, Ophis-operated) this solver competes on. */
  chainIds: readonly number[]
}

/**
 * Registry entries. The trailing comment names the underlying solver for
 * maintainers only; that brand string is never rendered (see the alias layer).
 */
export const OPHIS_SOLVERS: readonly OphisStaticSolverInfo[] = [
  // Mirrors each stack's AUTOPILOT [[drivers]], the only list that decides which
  // lanes are dispatched an auction. Pinned per chain by
  // scripts/check-solver-registry-invariant.sh.
  //   chain 10   baseline, okx, kyberswap, velora, enso, lifi, openocean, dodo
  //   chain 130  baseline, okx, kyberswap, velora, openocean, dodo, lifi, enso
  //   chain 4663 baseline, lifi, kyberswap, uniswap-v4
  {
    solverId: 'baseline',
    chainIds: [
      OPHIS_SOLVER_REGISTRY_CHAIN_ID,
      OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID,
      OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID,
    ],
  }, // Ophis baseline solver
  {
    solverId: 'okx',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID, OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID],
  }, // OKX OnchainOS (external)
  {
    solverId: 'kyberswap',
    chainIds: [
      OPHIS_SOLVER_REGISTRY_CHAIN_ID,
      OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID,
      OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID,
    ],
  }, // external aggregator
  {
    solverId: 'velora',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID, OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID],
  }, // external aggregator
  {
    solverId: 'enso',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID, OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID],
  }, // external routing engine
  {
    solverId: 'lifi',
    chainIds: [
      OPHIS_SOLVER_REGISTRY_CHAIN_ID,
      OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID,
      OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID,
    ],
  }, // external aggregation layer
  {
    solverId: 'openocean',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID, OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID],
  }, // external aggregator
  {
    solverId: 'dodo',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID, OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID],
  }, // external aggregator
  { solverId: 'uniswap-v4', chainIds: [OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID] }, // direct on-chain lane
  // No odos entry: #996 removed that lane from BOTH sovereign autopilots after
  // its API began answering 410. It is in no autopilot, so it is in no registry.
]

/** Neutral, brand-free label shown for every external (non-Ophis) solver. */
export const OPHIS_EXTERNAL_SOLVER_LABEL = 'External solver'

/**
 * Display-alias layer: internal solverId -> brand-neutral public label.
 *
 * Safe by default: any id that is not an Ophis-run solver neutralizes to
 * `OPHIS_EXTERNAL_SOLVER_LABEL`, so a newly added third-party solver can never
 * leak its brand into rendered copy without an explicit opt-in here.
 */
export function ophisSolverPublicLabel(solverId: string): string {
  const normalizedSolverId = solverId.toLowerCase()

  if (normalizedSolverId === 'baseline') return 'Baseline'
  if (normalizedSolverId === 'uniswap-v4') return 'Ophis direct solver'

  return OPHIS_EXTERNAL_SOLVER_LABEL
}

/** Brand-neutral description shown in the solver tooltip. */
export function ophisSolverPublicDescription(solverId: string): string {
  const normalizedSolverId = solverId.toLowerCase()

  if (normalizedSolverId === 'baseline') return 'Ophis baseline solver routing over on-chain liquidity.'
  if (normalizedSolverId === 'uniswap-v4') {
    return 'Ophis-operated direct solver routing through canonical on-chain liquidity.'
  }

  return 'An external solver competing in the Ophis batch auction to give you the best execution.'
}

/**
 * Registry entries competing on `chainId`, empty for CoW-hosted chains.
 *
 * Accepts `undefined` and answers empty, matching the other chain predicates
 * (`isVolumeOnlyChain`, `shouldEmitOphisPartnerFee`). "No chain yet" and "a chain
 * Ophis does not operate" are the same answer here, and pushing the guard to
 * every caller is how one of them forgets it.
 */
export function getOphisSolversForChain(chainId: number | undefined): OphisStaticSolverInfo[] {
  if (chainId === undefined) return []

  return OPHIS_SOLVERS.filter((solver) => solver.chainIds.includes(chainId))
}
