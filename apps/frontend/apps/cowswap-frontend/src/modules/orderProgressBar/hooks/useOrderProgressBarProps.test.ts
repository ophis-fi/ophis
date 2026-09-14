import { i18n, setupI18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'

import { getProgressBarStepName, mergeSolverData } from './useOrderProgressBarProps'

import { OrderProgressBarStepName } from '../constants'
import { OrderProgressBarState } from '../types'

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
  it.each([10, 130, 4663])('resolves a registered routing lane on chain %s without CMS data', (chainId) => {
    expect(mergeSolverData({ solver: 'kyberswap-solve' }, {}, chainId, i18n._.bind(i18n))).toMatchObject({
      solver: 'kyberswap',
      displayName: 'KyberSwap',
      description: 'Ophis-operated routing lane: KyberSwap.',
    })
  })

  it.each([
    [1, 'kyberswap'],
    [1, 'baseline'],
    [130, 'uniswap-v4'],
  ])('keeps missing metadata neutral on chain %s for solver %s', (chainId, solverId) => {
    expect(mergeSolverData({ solver: solverId }, {}, chainId, i18n._.bind(i18n))).toMatchObject({
      displayName: 'Unknown solver',
      description: `Solver identity unavailable (${solverId}).`,
    })
  })

  it.each([1, 4663])('preserves CMS attribution on chain %s', (chainId) => {
    const metadata = {
      solverId: 'kyberswap',
      displayName: 'CMS solver name',
      description: 'CMS operator description',
      solverNetworks: [],
    }
    expect(
      mergeSolverData({ solver: 'kyberswap-solve' }, { kyberswap: metadata }, chainId, i18n._.bind(i18n)),
    ).toMatchObject(metadata)
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
