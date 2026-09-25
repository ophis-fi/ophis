import { mapCmsSolversInfoToSolversInfo, SolverInfo } from '@cowprotocol/core'
import { getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'
import { getAddress } from '@ethersproject/address'

import { i18n } from '@lingui/core'
import { OPHIS_SOLVERS, ophisSolverPublicLabel } from 'ophis/solvers'

import { createHash } from 'crypto'

import { mergeSolverData } from './useOrderProgressBarProps'

jest.mock('@cowprotocol/common-utils', () => ({
  ...jest.requireActual('@cowprotocol/common-utils'),
  isBarnBackendEnv: false,
}))

const environment: { isBarnBackendEnv: boolean } = jest.requireMock('@cowprotocol/common-utils')
const seed = process.env.SOLVER_FUZZ_SEED || '20260925'
const runs = Number(process.env.SOLVER_FUZZ_RUNS || 1000)
const chains = Array.from(
  new Set([
    ...Object.values(SupportedChainId).filter((id): id is SupportedChainId => typeof id === 'number'),
    ...OPHIS_SOLVERS.flatMap(({ chainIds }) => chainIds),
  ]),
)
const translate = i18n._.bind(i18n)

beforeAll(() => {
  expect(Number.isSafeInteger(runs) && runs > 0 && runs <= 100000).toBe(true)
})

afterEach(() => {
  environment.isBarnBackendEnv = false
})

it.each([false, true])(
  'fuzzes deployment attribution (barn=%s)',
  (barn) => {
    environment.isBarnBackendEnv = barn
    for (const iteration of Array.from({ length: runs }, (_, index) => index)) {
      const bytes = createHash('sha256').update(`${seed}:${iteration}`).digest()
      const address = getAddress(`0x${bytes.toString('hex').slice(0, 40)}`)
      const chainIndex = bytes.readUInt16BE(0) % chains.length
      const chainId = chains[chainIndex] as SupportedChainId
      const wrongChain = chains[(chainIndex + 1) % chains.length] as SupportedChainId
      const env = barn ? 'staging' : 'prod'
      const cmsEnv = barn ? 'barn' : 'prod'
      const winner = Object.freeze({
        solver: bytes[2] % 2 ? address : getAddressKey(address),
        executedAmounts: Object.freeze({
          sell: BigInt(`0x${bytes.toString('hex')}`).toString(),
          buy: BigInt(`0x${Buffer.from(bytes).reverse().toString('hex')}`).toString(),
        }),
      })
      const [metadata] = mapCmsSolversInfoToSolversInfo([
        {
          attributes: {
            solverId: 'fuzz-team',
            displayName: `Team ${iteration}`,
            active: true,
            solver_networks: {
              data: [
                {
                  attributes: {
                    address,
                    network: { data: { attributes: { chainId } } },
                    environment: { data: { attributes: { name: cmsEnv } } },
                  },
                },
              ],
            },
          },
        },
      ])
      const networks = metadata.solverNetworks
      const noise: SolverInfo = {
        solverId: 'noise',
        displayName: 'Must not match',
        solverNetworks: [{ chainId: wrongChain, env, address }],
      }
      const variants: Array<[Record<string, SolverInfo>, string]> = [
        [{}, 'Unknown solver'],
        [{ team: metadata, noise }, metadata.displayName],
        [{ noise, team: metadata }, metadata.displayName],
        [{ team: { ...metadata, solverNetworks: [...networks, ...networks] } }, metadata.displayName],
        [{ team: metadata, other: { ...metadata, solverId: 'other' } }, 'Unknown solver'],
        [{ team: { ...metadata, solverNetworks: [{ chainId: wrongChain, env, address }] } }, 'Unknown solver'],
        [
          { team: { ...metadata, solverNetworks: [{ chainId, env: barn ? 'prod' : 'staging', address }] } },
          'Unknown solver',
        ],
        [{ team: { ...metadata, solverNetworks: [{ chainId, env }] } }, 'Unknown solver'],
        [
          {
            team: { ...metadata, solverNetworks: [{ chainId, env, address: `${address}x` }, ...noise.solverNetworks] },
          },
          'Unknown solver',
        ],
      ]
      for (const [records, expected] of variants) {
        const before = JSON.stringify(records)
        const result = mergeSolverData(winner, records, chainId, translate)
        // Include seed/case in assertion output so failures can be replayed exactly.
        expect({ seed, iteration, name: result.displayName }).toEqual({ seed, iteration, name: expected })
        expect(result.executedAmounts).toBe(winner.executedAmounts)
        expect(result.solver).toBe(winner.solver)
        expect(JSON.stringify(records)).toBe(before)
      }

      // Malformed solver strings, including prototype-like names, never acquire an identity.
      for (const solver of [bytes.toString('utf8'), `${address}x`, '__proto__', 'constructor', '']) {
        expect(mergeSolverData({ ...winner, solver }, {}, chainId, translate).displayName).toBe('Unknown solver')
      }
    }
  },
  60000,
)

it('fuzzes sovereign names, suffix normalization and chain isolation', () => {
  for (const iteration of Array.from({ length: runs }, (_, index) => index)) {
    const bytes = createHash('sha256').update(`${seed}:lane:${iteration}`).digest()
    const lane = OPHIS_SOLVERS[bytes[0] % OPHIS_SOLVERS.length]
    const chainId = lane.chainIds[bytes[1] % lane.chainIds.length]
    const solver = `${bytes[2] % 2 ? lane.solverId.toUpperCase() : lane.solverId}${bytes[3] % 2 ? '-solve' : ''}`
    const entry = { solver, executedAmounts: { sell: bytes[4].toString(), buy: bytes[5].toString() } }
    const result = mergeSolverData(entry, {}, chainId, translate)
    expect({ seed, iteration, name: result.displayName }).toEqual({
      seed,
      iteration,
      name: ophisSolverPublicLabel(lane.solverId),
    })
    expect(result.executedAmounts).toBe(entry.executedAmounts)
    expect(mergeSolverData(entry, {}, 999999, translate).displayName).toBe('Unknown solver')
  }
}, 60000)
