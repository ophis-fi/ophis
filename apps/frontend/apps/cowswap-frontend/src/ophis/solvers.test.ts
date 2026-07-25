import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

import { getOphisSolversForChain, OPHIS_SOLVER_REGISTRY_CHAIN_ID, OPHIS_SOLVERS } from './solvers'

// Repo-root driver config for the chain-10 orderbook. Six levels up from
// src/ophis: src -> cowswap-frontend -> apps -> frontend -> apps -> root.
const DRIVER_CONFIG_PATH = resolve(__dirname, '../../../../../../infra/optimism-mainnet/configs/driver.toml.tmpl')

function readDriverSolverNames(): string[] {
  const toml = readFileSync(DRIVER_CONFIG_PATH, 'utf8')
  // Strip comments so prose never contributes a name.
  const stripped = toml.replace(/#[^\n]*/g, '')
  const names: string[] = []
  const re = /\[\[solver\]\]\s*\n\s*name\s*=\s*"([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(stripped)) !== null) {
    names.push(match[1])
  }
  return names
}

describe('OPHIS_SOLVERS registry', () => {
  it('has unique lowercase solver ids and non-empty display data', () => {
    const ids = OPHIS_SOLVERS.map((solver) => solver.solverId)

    expect(new Set(ids).size).toBe(ids.length)

    for (const solver of OPHIS_SOLVERS) {
      expect(solver.solverId).toBe(solver.solverId.toLowerCase())
      expect(solver.displayName.length).toBeGreaterThan(0)
      expect(solver.description.length).toBeGreaterThan(0)
      expect(solver.chainIds.length).toBeGreaterThan(0)
    }
  })

  it('filters by chain', () => {
    expect(getOphisSolversForChain(OPHIS_SOLVER_REGISTRY_CHAIN_ID).length).toBe(OPHIS_SOLVERS.length)
    expect(getOphisSolversForChain(1).length).toBe(0)
  })

  it('mirrors the chain-10 driver config solver names exactly', () => {
    // The invariant script (scripts/check-solver-registry-invariant.sh) is the
    // CI hard gate; this mirror test gives the same signal inside the jest
    // lane. Skipped when the infra tree is not present (isolated checkouts).
    if (!existsSync(DRIVER_CONFIG_PATH)) {
      console.warn(`skipping driver-config mirror check: ${DRIVER_CONFIG_PATH} not found`)
      return
    }

    const driverNames = readDriverSolverNames().sort()
    const registryIds = getOphisSolversForChain(OPHIS_SOLVER_REGISTRY_CHAIN_ID)
      .map((solver) => solver.solverId)
      .sort()

    expect(driverNames.length).toBeGreaterThan(0)
    expect(registryIds).toEqual(driverNames)
  })
})
