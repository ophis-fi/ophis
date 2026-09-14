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
  it('resolves a known routing lane while CMS data is unavailable', () => {
    expect(mergeSolverData({ solver: 'kyberswap-solve' }, {})).toMatchObject({
      solver: 'kyberswap',
      displayName: 'KyberSwap',
    })
  })

  it('keeps an unknown address in details instead of using it as the solver name', () => {
    const address = '0x95f0beaB29BeA3D18A7c81140AED9227Ff2D7665'
    const solver = mergeSolverData({ solver: address }, {})
    expect(solver.displayName).toBe('Unknown solver')
    expect(solver.description).toContain(address)
    expect(solver.solver).toBe(address)
  })
})
