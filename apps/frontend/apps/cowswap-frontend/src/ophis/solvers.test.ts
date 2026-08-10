import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

import {
  getOphisSolversForChain,
  OPHIS_EXTERNAL_SOLVER_LABEL,
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

// Third-party / competitor brand tokens that must never appear in any rendered
// solver string. Ophis public copy never names a competitor (standing rule).
const BANNED_BRAND_TOKENS = [
  'kyberswap',
  'kyber',
  'okx',
  'velora',
  'paraswap',
  'enso',
  'lifi',
  'li.fi',
  'openocean',
  'dodo',
  '1inch',
  'oneinch',
]

function readAutopilotDriverNames(path = AUTOPILOT_CONFIG_PATH): string[] {
  const toml = readFileSync(path, 'utf8')
  // Strip comments so prose never contributes a name.
  const stripped = toml.replace(/#[^\n]*/g, '')
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
})

describe('solver display-alias layer', () => {
  it('labels the Ophis baseline solver plainly', () => {
    expect(ophisSolverPublicLabel('baseline')).toBe('Baseline')
    expect(ophisSolverPublicLabel('BASELINE')).toBe('Baseline')
    expect(ophisSolverPublicDescription('baseline')).toMatch(/Ophis baseline/i)
  })

  it('labels the Ophis-operated direct solver distinctly', () => {
    expect(ophisSolverPublicLabel('uniswap-v4')).toBe('Ophis direct solver')
    expect(ophisSolverPublicLabel('UNISWAP-V4')).toBe('Ophis direct solver')
    expect(ophisSolverPublicLabel('ekubo')).toBe('Ophis direct solver')
    expect(ophisSolverPublicLabel('up33')).toBe('Ophis direct solver')
    expect(ophisSolverPublicDescription('uniswap-v4')).toMatch(/Ophis-operated direct solver/i)
  })

  it('neutralizes every external / competitor solver brand', () => {
    // The Ophis-RUN solvers keep a plain descriptive label; everything else must
    // neutralize. `uniswap-v4` joined that set when the Robinhood direct lane
    // shipped, and this loop was not updated, so it has been failing since.
    const OPHIS_RUN_SOLVER_IDS = ['baseline', 'uniswap-v4', 'ekubo', 'up33']

    for (const solver of OPHIS_SOLVERS) {
      if (OPHIS_RUN_SOLVER_IDS.includes(solver.solverId)) continue
      expect(ophisSolverPublicLabel(solver.solverId)).toBe(OPHIS_EXTERNAL_SOLVER_LABEL)
    }
  })

  it('neutralizes unknown solver ids by default (safe by default)', () => {
    expect(ophisSolverPublicLabel('some-new-aggregator')).toBe(OPHIS_EXTERNAL_SOLVER_LABEL)
  })

  it('never leaks a competitor brand in any rendered solver string', () => {
    for (const solver of OPHIS_SOLVERS) {
      const rendered = `${ophisSolverPublicLabel(solver.solverId)} ${ophisSolverPublicDescription(solver.solverId)}`
      const lower = rendered.toLowerCase()

      for (const brand of BANNED_BRAND_TOKENS) {
        expect(lower).not.toContain(brand)
      }
    }
  })
})
