import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { act, renderHook, waitFor } from '@testing-library/react'
import { useOrderByNetwork } from 'hooks/useOperatorOrder'
import {
  GetOrderResult,
  SingleOrder,
  tryGetOrderOnAllNetworksAndEnvironments,
} from 'services/helpers/tryGetOrderOnAllNetworks'

import { RAW_ORDER } from '../data/operator'

jest.mock('services/helpers/tryGetOrderOnAllNetworks', () => ({
  tryGetOrderOnAllNetworksAndEnvironments: jest.fn(),
}))
jest.mock('api/operator', () => ({
  ...jest.requireActual('../../api/operator/types'),
  getOrder: jest.fn(),
}))
jest.mock('state/network', () => ({ useNetworkId: jest.fn() }))
jest.mock('../../hooks/useErc20', () => ({ useMultipleErc20: jest.fn() }))
jest.mock('utils', () => ({
  transformOrder: (order: { uid: string; validTo: number }) => ({
    ...order,
    expirationDate: new Date(order.validTo * 1000),
  }),
}))

const mockedLookup = jest.mocked(tryGetOrderOnAllNetworksAndEnvironments)
type LookupResult = GetOrderResult<SingleOrder>

function deferredLookup(): { promise: Promise<LookupResult>; resolve: (result: LookupResult) => void } {
  let resolve: (result: LookupResult) => void = () => undefined
  const promise = new Promise<LookupResult>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('useOrderByNetwork', () => {
  beforeEach(() => {
    mockedLookup.mockReset()
  })

  it('clears a displayed order when another UID is missing', async () => {
    mockedLookup.mockResolvedValueOnce({ order: RAW_ORDER }).mockResolvedValueOnce({ order: null })
    const { result, rerender } = renderHook(({ uid }) => useOrderByNetwork(uid, SupportedChainId.MAINNET), {
      initialProps: { uid: RAW_ORDER.uid },
    })
    await waitFor(() => expect(result.current.order?.uid).toBe(RAW_ORDER.uid))

    rerender({ uid: 'missing-order' })
    expect(result.current.order).toBeNull()
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.order).toBeNull()
    expect(result.current.errorOrderPresentInNetworkId).toBeNull()
  })

  it('ignores an older request that resolves after the current order', async () => {
    const older = deferredLookup()
    const newer = deferredLookup()
    mockedLookup.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const { result, rerender } = renderHook(({ uid }) => useOrderByNetwork(uid, SupportedChainId.MAINNET), {
      initialProps: { uid: 'older' },
    })
    rerender({ uid: 'newer' })
    await act(async () => newer.resolve({ order: { ...RAW_ORDER, uid: 'newer' } }))
    expect(result.current.order?.uid).toBe('newer')

    await act(async () => older.resolve({ order: { ...RAW_ORDER, uid: 'older' } }))
    expect(result.current.order?.uid).toBe('newer')
    expect(result.current.isLoading).toBe(false)
  })

  it('clears the wrong-network marker when navigating to the correct network', async () => {
    const nextNetwork = deferredLookup()
    mockedLookup
      .mockResolvedValueOnce({ order: RAW_ORDER, errorOrderPresentInNetworkId: SupportedChainId.BASE })
      .mockReturnValueOnce(nextNetwork.promise)
    const { result, rerender } = renderHook(({ network }) => useOrderByNetwork(RAW_ORDER.uid, network), {
      initialProps: { network: SupportedChainId.MAINNET },
    })
    await waitFor(() => expect(result.current.errorOrderPresentInNetworkId).toBe(SupportedChainId.BASE))

    rerender({ network: SupportedChainId.BASE })
    expect(result.current.order).toBeNull()
    expect(result.current.errorOrderPresentInNetworkId).toBeNull()
    await act(async () => nextNetwork.resolve({ order: RAW_ORDER }))
    expect(result.current.order?.uid).toBe(RAW_ORDER.uid)
    expect(result.current.errorOrderPresentInNetworkId).toBeNull()
  })

  it.each(['null', 'rejection'])('keeps polling the same unexpired order after a %s refresh', async (failure) => {
    jest.useFakeTimers()
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const activeOrder = { ...RAW_ORDER, validTo: Math.floor(Date.now() / 1000) + 60 }
      mockedLookup.mockResolvedValueOnce({ order: activeOrder })
      if (failure === 'null') mockedLookup.mockResolvedValueOnce({ order: null })
      else mockedLookup.mockRejectedValueOnce(new Error('unavailable'))
      mockedLookup.mockResolvedValueOnce({ order: { ...activeOrder, invalidated: true } })
      const { result, unmount } = renderHook(() => useOrderByNetwork(RAW_ORDER.uid, SupportedChainId.MAINNET, 1000))
      await act(async () => undefined)
      expect(result.current.order?.uid).toBe(RAW_ORDER.uid)

      await act(async () => jest.advanceTimersByTime(1000))
      expect(result.current.order?.uid).toBe(RAW_ORDER.uid)
      expect(result.current.error?.message).toContain('Failed to fetch order')

      await act(async () => jest.advanceTimersByTime(1000))
      expect(mockedLookup).toHaveBeenCalledTimes(3)
      expect(result.current.order).toMatchObject({ uid: RAW_ORDER.uid, invalidated: true })
      expect(result.current.error).toBeUndefined()
      unmount()
    } finally {
      error.mockRestore()
      jest.useRealTimers()
    }
  })
})
