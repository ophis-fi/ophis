import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

import {
  getOphisSolversForChain,
  OPHIS_ARC_SOLVER_REGISTRY_CHAIN_ID,
  OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID,
  OPHIS_SOLVER_REGISTRY_CHAIN_ID,
  OPHIS_SOLVERS,
  ophisSolverPublicDescription,
  ophisSolverPublicLabel,
} from './solvers'

// Repo-root driver config for the chain-10 orderbook. Six levels up from
// src/ophis: src -> cowswap-frontend -> apps -> frontend -> apps -> root.
// The AUTOPILOT, not driver.toml.tmpl: a lane only competes if the autopilot
// dispatches an auction to it. Mirrors scripts/check-solver-registry-invariant.sh.
const AUTOPILOT_CONFIG_PATH = resolve(__dirname, '../../../../../../infra/optimism-mainnet/configs/autopilot.toml')
const ROBINHOOD_AUTOPILOT_CONFIG_PATH = resolve(
  __dirname,
  '../../../../../../infra/robinhood-mainnet/configs/autopilot.toml.tmpl',
)
// Arc's autopilot template is embedded in the release renderer; do not run it.
const ARC_AUTOPILOT_CONFIG_PATH = resolve(__dirname, '../../../../../../infra/arc-mainnet/release/render.py')

function readAutopilotDriverNames(path = AUTOPILOT_CONFIG_PATH): string[] {
  const toml = readFileSync(path, 'utf8')
  // Strip comments so prose never contributes a name.
  const stripped = toml.replace(/#[^\n]*/g, '')
  if (path === ARC_AUTOPILOT_CONFIG_PATH) {
    const lanes = stripped.match(/^\s*lanes\s*=\s*\[([^\]]*)\]/m)?.[1] || ''
    return Array.from(lanes.matchAll(/'([^']+)'/g), (match) => match[1])
  }
  const names: string[] = []
  const re = /\[\[drivers\]\]\s*\n\s*name\s*=\s*"([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(stripped)) !== null) {
    names.push(match[1])
  }
  return names
}

describe('OPHIS_SOLVERS registry', () => {
  it('has unique lowercase solver ids on at least one chain', () => {
    const ids = OPHIS_SOLVERS.map((solver) => solver.solverId)

    expect(new Set(ids).size).toBe(ids.length)

    for (const solver of OPHIS_SOLVERS) {
      expect(solver.solverId).toBe(solver.solverId.toLowerCase())
      expect(solver.chainIds.length).toBeGreaterThan(0)
    }
  })

  it('filters by chain', () => {
    expect(getOphisSolversForChain(OPHIS_SOLVER_REGISTRY_CHAIN_ID)).toEqual(
      OPHIS_SOLVERS.filter(({ chainIds }) => chainIds.includes(OPHIS_SOLVER_REGISTRY_CHAIN_ID)),
    )
    expect(getOphisSolversForChain(OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID).map(({ solverId }) => solverId)).toEqual([
      'baseline',
      'kyberswap',
      'lifi',
      'uniswap-v4',
      'pancakeswap',
      'ramses',
      'fables',
      'ekubo',
      'up33',
      'pools',
    ])
    expect(getOphisSolversForChain(1).length).toBe(0)
  })

  it('mirrors the chain-10 autopilot driver names exactly', () => {
    // The invariant script (scripts/check-solver-registry-invariant.sh) is the
    // CI hard gate; this mirror test gives the same signal inside the jest
    // lane. Skipped when the infra tree is not present (isolated checkouts).
    if (!existsSync(AUTOPILOT_CONFIG_PATH)) {
      console.warn(`skipping autopilot mirror check: ${AUTOPILOT_CONFIG_PATH} not found`)
      return
    }

    const driverNames = readAutopilotDriverNames().sort()
    const registryIds = getOphisSolversForChain(OPHIS_SOLVER_REGISTRY_CHAIN_ID)
      .map((solver) => solver.solverId)
      .sort()

    expect(driverNames.length).toBeGreaterThan(0)
    expect(registryIds).toEqual(driverNames)
  })

  it('mirrors the Robinhood autopilot driver names exactly', () => {
    if (!existsSync(ROBINHOOD_AUTOPILOT_CONFIG_PATH)) {
      console.warn(`skipping Robinhood autopilot mirror check: ${ROBINHOOD_AUTOPILOT_CONFIG_PATH} not found`)
      return
    }

    const driverNames = readAutopilotDriverNames(ROBINHOOD_AUTOPILOT_CONFIG_PATH).sort()
    const registryIds = getOphisSolversForChain(OPHIS_ROBINHOOD_SOLVER_REGISTRY_CHAIN_ID)
      .map((solver) => solver.solverId)
      .sort()

    expect(driverNames.length).toBeGreaterThan(0)
    expect(registryIds).toEqual(driverNames)
  })

  it('mirrors the Arc autopilot driver names exactly', () => {
    if (!existsSync(ARC_AUTOPILOT_CONFIG_PATH)) {
      console.warn(`skipping Arc autopilot mirror check: ${ARC_AUTOPILOT_CONFIG_PATH} not found`)
      return
    }

    const driverNames = readAutopilotDriverNames(ARC_AUTOPILOT_CONFIG_PATH).sort()
    const registryIds = getOphisSolversForChain(OPHIS_ARC_SOLVER_REGISTRY_CHAIN_ID)
      .map((solver) => solver.solverId)
      .sort()

    expect(driverNames).toEqual(['kyberswap', 'uniswap-v3'])
    expect(registryIds).toEqual(driverNames)
  })
})

describe('solver display names', () => {
  it('works in browsers without Object.hasOwn', () => {
    const hasOwn = Object.hasOwn
    let label: string | undefined
    Object.defineProperty(Object, 'hasOwn', { value: undefined })
    try {
      label = ophisSolverPublicLabel('kyberswap')
    } finally {
      Object.defineProperty(Object, 'hasOwn', { value: hasOwn })
    }
    expect(label).toBe('KyberSwap')
  })

  it.each([
    ['baseline', 'Ophis Baseline'],
    ['KYBERSWAP', 'KyberSwap'],
    ['lifi-solve', 'LI.FI'],
    ['uniswap-v4', 'Uniswap v4'],
    ['uniswap-v3', 'Uniswap v3'],
    ['ekubo', 'Ekubo'],
    ['up33', 'UP33'],
    ['pools', 'Pools.trade'],
  ])('names the %s routing lane', (id, label) => {
    expect(ophisSolverPublicLabel(id)).toBe(label)
    expect(ophisSolverPublicDescription(id)).toContain('Ophis-operated')
  })

  it('gives every registered routing lane a distinct name', () => {
    const labels = OPHIS_SOLVERS.map(({ solverId }) => ophisSolverPublicLabel(solverId))
    expect(new Set(labels).size).toBe(OPHIS_SOLVERS.length)
    expect(labels).not.toContain('Unknown solver')
  })

  it.each(['0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665', 'unregistered', 'constructor', '__proto__'])(
    'keeps unidentified solver %s out of the display label',
    (id) => {
      expect(ophisSolverPublicLabel(id)).toBe('Unknown solver')
      expect(ophisSolverPublicDescription(id)).toContain(id)
    },
  )
})
