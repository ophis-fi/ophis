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
 * Public names identify each routing lane; internal ids still mirror autopilot.
 * All entries are Ophis-operated, including lanes that query external aggregators.
 *
 * Counts derived from this registry are phrased "up to N": being dispatched an
 * auction does not guarantee a solver returns a solution for it.
 */

/** Chain id of the Ophis-operated Optimism orderbook. */
export const OPHIS_SOLVER_REGISTRY_CHAIN_ID = 10
export const OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID = 130
export const OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID = 4663
export const OPHIS_ARC_SOLVER_REGISTRY_CHAIN_ID = 5042

export interface OphisStaticSolverInfo {
  /**
   * Lowercase id, byte-identical to the autopilot `[[drivers]] name`. Used
   * for CMS matching and attribution; public labels come from the name map below.
   */
  solverId: string
  /** Chains (sovereign, Ophis-operated) this solver competes on. */
  chainIds: readonly number[]
}

/**
 * Registry entries and the underlying routing providers.
 */
export const OPHIS_SOLVERS: readonly OphisStaticSolverInfo[] = [
  // Mirrors each stack's AUTOPILOT [[drivers]], the only list that decides which
  // lanes are dispatched an auction. Pinned per chain by
  // scripts/check-solver-registry-invariant.sh.
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
      OPHIS_ARC_SOLVER_REGISTRY_CHAIN_ID,
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
  { solverId: 'curve', chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID] }, // direct on-chain lane
  { solverId: 'woofi', chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID] }, // direct on-chain lane
  { solverId: 'uniswap-v3', chainIds: [OPHIS_ARC_SOLVER_REGISTRY_CHAIN_ID] }, // direct on-chain lane
  {
    solverId: 'uniswap-v4',
    chainIds: [
      OPHIS_SOLVER_REGISTRY_CHAIN_ID,
      OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID,
      OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID,
    ],
  }, // direct on-chain lane
  {
    solverId: 'velodrome',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID, OPHIS_UNICHAIN_SOLVER_REGISTRY_CHAIN_ID],
  },
  { solverId: 'velodrome-slipstream', chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID] },
  { solverId: 'pancakeswap', chainIds: [OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID] },
  { solverId: 'ramses', chainIds: [OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID] },
  { solverId: 'fables', chainIds: [OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID] },
  { solverId: 'ekubo', chainIds: [OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID] }, // direct on-chain lane
  { solverId: 'up33', chainIds: [OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID] }, // direct on-chain lane
  { solverId: 'pools', chainIds: [OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID] }, // pools.trade via Nordstern
  // No odos entry: #996 removed that lane from BOTH sovereign autopilots after
  // its API began answering 410. It is in no autopilot, so it is in no registry.
]

const OPHIS_SOLVER_NAMES: Record<string, string> = {
  baseline: 'Ophis Baseline',
  okx: 'OKX',
  kyberswap: 'KyberSwap',
  velora: 'Velora',
  enso: 'Enso',
  lifi: 'LI.FI',
  openocean: 'OpenOcean',
  dodo: 'DODO',
  curve: 'Curve',
  woofi: 'WOOFi',
  'uniswap-v3': 'Uniswap v3',
  'uniswap-v4': 'Uniswap v4',
  velodrome: 'Velodrome',
  'velodrome-slipstream': 'Velodrome Slipstream',
  pancakeswap: 'PancakeSwap',
  ramses: 'RamsesX',
  fables: 'Fables',
  ekubo: 'Ekubo',
  up33: 'UP33',
  pools: 'Pools.trade',
}

export function ophisSolverPublicLabel(solverId: string): string {
  const key = solverId.toLowerCase().replace(/-solve$/, '')
  return Object.prototype.hasOwnProperty.call(OPHIS_SOLVER_NAMES, key) ? OPHIS_SOLVER_NAMES[key] : 'Unknown solver'
}

export function ophisSolverPublicDescription(solverId: string): string {
  const label = ophisSolverPublicLabel(solverId)
  return label === 'Unknown solver'
    ? `Solver identity unavailable (${solverId}).`
    : `Ophis-operated routing lane: ${label}.`
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
