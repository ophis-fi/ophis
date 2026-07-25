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
 * `[[solver]] name = "..."` entries in
 * `infra/optimism-mainnet/configs/driver.toml.tmpl` (repo root). Guarded by
 * `scripts/check-solver-registry-invariant.sh` (security.yml hard gate) plus
 * the jest mirror test in `solvers.test.ts`. Update both sides in the same PR.
 *
 * Counts derived from this registry are phrased "up to N": listing in the
 * driver config does not guarantee a solver bids on every auction.
 */

/** Chain id of the Ophis-operated Optimism orderbook. */
export const OPHIS_SOLVER_REGISTRY_CHAIN_ID = 10

export interface OphisStaticSolverInfo {
  /** Lowercase id, byte-identical to the driver.toml.tmpl `name`. */
  solverId: string
  displayName: string
  description: string
  /** Chains (sovereign, Ophis-operated) this solver competes on. */
  chainIds: readonly number[]
}

export const OPHIS_SOLVERS: readonly OphisStaticSolverInfo[] = [
  {
    solverId: 'baseline',
    displayName: 'Baseline',
    description: 'Ophis baseline solver routing over on-chain AMM liquidity.',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID],
  },
  {
    solverId: 'okx',
    displayName: 'OKX',
    description: 'OKX OnchainOS aggregator covering UniV3, Velodrome, Curve, Balancer and long-tail liquidity.',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID],
  },
  {
    solverId: 'kyberswap',
    displayName: 'KyberSwap',
    description: 'KyberSwap aggregator competing over the major Optimism DEX venues.',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID],
  },
  {
    solverId: 'velora',
    displayName: 'Velora',
    description: 'Velora (formerly ParaSwap) aggregator with Augustus V6.2 routing.',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID],
  },
  {
    solverId: 'odos',
    displayName: 'Odos',
    description: 'Odos aggregator API routing over Optimism DEX liquidity.',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID],
  },
  {
    solverId: 'enso',
    displayName: 'Enso',
    description: 'Enso routing engine covering DeFi positions and DEX liquidity.',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID],
  },
  {
    solverId: 'lifi',
    displayName: 'LI.FI',
    description: 'LI.FI aggregation layer routing across Optimism DEX venues.',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID],
  },
  {
    solverId: 'openocean',
    displayName: 'OpenOcean',
    description: 'OpenOcean aggregator routing over Optimism DEX liquidity.',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID],
  },
  {
    solverId: 'dodo',
    displayName: 'DODO',
    description: 'DODO aggregator with PMM and AMM routing on Optimism.',
    chainIds: [OPHIS_SOLVER_REGISTRY_CHAIN_ID],
  },
]

/** Registry entries competing on `chainId` (empty for CoW-hosted chains). */
export function getOphisSolversForChain(chainId: number): OphisStaticSolverInfo[] {
  return OPHIS_SOLVERS.filter((solver) => solver.chainIds.includes(chainId))
}
