import { useAtomValue } from 'jotai'

import { mapCmsSolversInfoToSolversInfo, SolverInfo } from '@cowprotocol/core'
import { getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'

import { i18n, setupI18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { renderHook } from '@testing-library/react'

import { useSolversInfo } from 'common/hooks/useSolversInfo'

import { getProgressBarStepName, mergeSolverData } from './useOrderProgressBarProps'

import { OrderProgressBarStepName } from '../constants'
import { OrderProgressBarState } from '../types'

jest.mock('jotai', () => ({ ...jest.requireActual('jotai'), useAtomValue: jest.fn() }))
jest.mock('@cowprotocol/common-utils', () => ({
  ...jest.requireActual('@cowprotocol/common-utils'),
  isBarnBackendEnv: false,
}))

const OPEN_STATUS = 'open' as OrderProgressBarState['backendApiStatus']
const EXECUTING_STATUS = 'executing' as OrderProgressBarState['backendApiStatus']

describe('getProgressBarStepName', () => {
  function callGetProgressBarStepName({
    isUnfillable = false,
    backendApiStatus,
    previousStepName = OrderProgressBarStepName.SOLVING,
    previousBackendApiStatus,
  }: {
    isUnfillable?: boolean
    backendApiStatus?: OrderProgressBarState['backendApiStatus']
    previousStepName?: OrderProgressBarStepName | undefined
    previousBackendApiStatus?: OrderProgressBarState['previousBackendApiStatus']
  }): OrderProgressBarStepName {
    return getProgressBarStepName(
      isUnfillable,
      false, // isCancelled
      false, // isExpired
      false, // isCancelling
      undefined, // cancellationTriggered
      false, // isConfirmed
      null, // countdown
      backendApiStatus,
      previousBackendApiStatus,
      previousStepName,
      undefined, // bridgingStatus
      false, // isBridgingTrade
    )
  }

  it('keeps the solving animation when an order recovers from unfillable without backend status', () => {
    const result = callGetProgressBarStepName({
      previousStepName: OrderProgressBarStepName.UNFILLABLE,
    })

    expect(result).toBe(OrderProgressBarStepName.SOLVING)
  })

  it('keeps the solving animation when backend status is open after an unfillable recovery', () => {
    const result = callGetProgressBarStepName({
      backendApiStatus: OPEN_STATUS,
      previousStepName: OrderProgressBarStepName.UNFILLABLE,
    })

    expect(result).toBe(OrderProgressBarStepName.SOLVING)
  })

  it('still transitions to executing when the backend reports progress', () => {
    const result = callGetProgressBarStepName({
      backendApiStatus: EXECUTING_STATUS,
      previousStepName: OrderProgressBarStepName.UNFILLABLE,
      previousBackendApiStatus: OPEN_STATUS,
    })

    expect(result).toBe(OrderProgressBarStepName.EXECUTING)
  })
})

describe('solver attribution', () => {
  const address = '0xb222da0155640eB2f604164d4a3684139dcC1f95'

  it.each(Object.values(SupportedChainId).filter((id): id is SupportedChainId => typeof id === 'number'))(
    'resolves a CMS deployment address on chain %s without counting it twice',
    (chainId) => {
      const metadata = mapCmsSolversInfoToSolversInfo([
        {
          attributes: {
            solverId: 'brrr',
            displayName: 'BRRRolver',
            active: true,
            solver_networks: {
              data: [
                {
                  attributes: {
                    address,
                    network: { data: { attributes: { chainId } } },
                    environment: { data: { attributes: { name: 'prod' } } },
                  },
                },
              ],
            },
          },
        },
      ])
      ;(useAtomValue as jest.MockedFunction<typeof useAtomValue>).mockReturnValue(metadata)
      const { result } = renderHook(() => useSolversInfo(chainId))
      const winner = { solver: getAddressKey(address), executedAmounts: { sell: '1000', buy: '999' } }

      expect(Object.keys(result.current)).toEqual(['brrr'])
      expect(mergeSolverData(winner, result.current, chainId, i18n._.bind(i18n))).toMatchObject({
        ...winner,
        displayName: 'BRRRolver',
      })
    },
  )

  it.each([
    { chainId: SupportedChainId.MAINNET, env: 'prod' as const },
    { chainId: SupportedChainId.BASE, env: 'staging' as const },
  ])('does not borrow an address identity from another deployment: %j', (network) => {
    const brrr: SolverInfo = {
      solverId: 'brrr',
      displayName: 'BRRRolver',
      solverNetworks: [{ ...network, address }],
    }
    expect(mergeSolverData({ solver: address }, { brrr }, SupportedChainId.BASE, i18n._.bind(i18n)).displayName).toBe(
      'Unknown solver',
    )
  })

  it('does not guess when multiple teams claim the same deployment address', () => {
    const brrr: SolverInfo = {
      solverId: 'brrr',
      displayName: 'BRRRolver',
      solverNetworks: [{ chainId: SupportedChainId.BASE, env: 'prod', address }],
    }
    const metadata = { brrr, another: { ...brrr, solverId: 'another', displayName: 'Another solver' } }
    expect(mergeSolverData({ solver: address }, metadata, SupportedChainId.BASE, i18n._.bind(i18n)).displayName).toBe(
      'Unknown solver',
    )
  })

  it('names the winner from the reported Arc USDC/EURC order without CMS data', () => {
    // Public Arc order status on 2026-09-24: 2 USDC sold for 1.740907 EURC.
    const winner = { solver: 'uniswap-v3', executedAmounts: { sell: '2000000', buy: '1740907' } }
    expect(mergeSolverData(winner, {}, 5042, i18n._.bind(i18n))).toMatchObject({
      ...winner,
      displayName: 'Ophis',
      route: 'Uniswap v3',
      image: '/ophis-icon.svg',
      description: 'Ophis-operated routing lane: Uniswap v3.',
    })
  })

  it.each([10, 130, 4663, 5042])('resolves a registered routing lane on chain %s without CMS data', (chainId) => {
    expect(mergeSolverData({ solver: 'kyberswap-solve' }, {}, chainId, i18n._.bind(i18n))).toMatchObject({
      solver: 'kyberswap',
      displayName: 'Ophis',
      route: 'KyberSwap',
      description: 'Ophis-operated routing lane: KyberSwap.',
    })
  })

  it.each([
    [1, 'kyberswap'],
    [1, 'baseline'],
    [130, 'unregistered'],
  ])('keeps missing metadata neutral on chain %s for solver %s', (chainId, solverId) => {
    expect(mergeSolverData({ solver: solverId }, {}, chainId, i18n._.bind(i18n))).toMatchObject({
      displayName: 'Unknown solver',
      description: `Solver identity unavailable (${solverId}).`,
    })
  })

  it.each([1, 4663])('preserves independent CMS attribution on chain %s', (chainId) => {
    const metadata = {
      solverId: 'external-solver',
      displayName: 'CMS solver name',
      description: 'CMS operator description',
      solverNetworks: [],
    }
    expect(
      mergeSolverData({ solver: 'external-solver-solve' }, { 'external-solver': metadata }, chainId, i18n._.bind(i18n)),
    ).toMatchObject({ ...metadata, route: undefined })
  })

  it('does not let a CMS name collision relabel an Ophis lane or overwrite an independent address identity', () => {
    const metadata: SolverInfo = {
      solverId: 'kyberswap',
      displayName: 'External Kyber solver',
      image: 'https://example.com/solver.svg',
      solverNetworks: [{ chainId: 5042 as SupportedChainId, env: 'prod', address }],
    }
    const solvers = { kyberswap: metadata }
    expect(mergeSolverData({ solver: 'kyberswap' }, solvers, 5042, i18n._.bind(i18n))).toMatchObject({
      displayName: 'Ophis',
      route: 'KyberSwap',
      image: '/ophis-icon.svg',
    })
    expect(mergeSolverData({ solver: address }, solvers, 5042, i18n._.bind(i18n))).toMatchObject({
      displayName: metadata.displayName,
      image: metadata.image,
      route: undefined,
    })
    expect(mergeSolverData({ solver: 'kyberswap' }, solvers, 1, i18n._.bind(i18n))).toMatchObject({
      displayName: metadata.displayName,
      route: undefined,
    })
  })

  it('keeps a missing CMS description neutral on a CoW-hosted chain', () => {
    const metadata = { solverId: 'baseline', displayName: 'Baseline', solverNetworks: [] }
    expect(mergeSolverData({ solver: 'baseline' }, { baseline: metadata }, 1, i18n._.bind(i18n))).toMatchObject({
      displayName: 'Baseline',
      description: 'Solver identity unavailable (baseline).',
    })
  })

  it.each([1, 4663])('keeps unknown addresses in details on chain %s', (chainId) => {
    const address = '0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665'
    const solver = mergeSolverData({ solver: address }, {}, chainId, i18n._.bind(i18n))
    expect(solver.displayName).toBe('Unknown solver')
    expect(solver.description).toContain(address)
    expect(solver.solver).toBe(address)
  })
})

it.each([
  ['es-ES', 'Solucionador desconocido', 'Identidad del solucionador no disponible ({solverId}).'],
  ['ru-RU', 'Неизвестный солвер', 'Данные о солвере недоступны ({solverId}).'],
])('translates missing solver metadata in %s and preserves its identity', (locale, label, description) => {
  const solverId = 'unregistered'
  const localized = setupI18n({
    locale,
    messages: {
      [locale]: {
        [msg`Unknown solver`.id]: label,
        [msg`Solver identity unavailable (${solverId}).`.id]: description,
      },
    },
  })
  expect(mergeSolverData({ solver: solverId }, {}, 1, localized._.bind(localized))).toMatchObject({
    displayName: label,
    description: description.replace('{solverId}', solverId),
  })
})
