import { AnyAction } from 'redux'
import { instance, mock, resetCalls, when } from 'ts-mockito'

import { ophisEnrollMiddleware } from './ophisEnrollMiddleware'

const nextMock = jest.fn()
const actionMock = mock<AnyAction>()

const dispatch = (): unknown => ophisEnrollMiddleware()(nextMock)(instance(actionMock))

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('ophisEnrollMiddleware', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    resetCalls(actionMock)
    nextMock.mockClear()
    fetchMock = jest.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('enrolls the order owner (lowercased) when an order is placed, and always forwards the action', () => {
    const owner = '0x04981fF1F1a901B0F5221af38E7Ee4ACa8353A27'
    when(actionMock.type).thenReturn('order/addPendingOrder')
    when(actionMock.payload).thenReturn({ chainId: 1, order: { owner } })

    dispatch()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(`https://rebates.ophis.fi/tier/${owner.toLowerCase()}`)
    expect(nextMock).toHaveBeenCalledTimes(1)
  })

  it('does not enroll on non-order actions', () => {
    when(actionMock.type).thenReturn('order/fulfillOrdersBatch')
    when(actionMock.payload).thenReturn({ chainId: 1, orders: [] })

    dispatch()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(nextMock).toHaveBeenCalledTimes(1)
  })

  it('skips malformed owner addresses', () => {
    when(actionMock.type).thenReturn('order/addPendingOrder')
    when(actionMock.payload).thenReturn({ chainId: 1, order: { owner: 'not-an-address' } })

    dispatch()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(nextMock).toHaveBeenCalledTimes(1)
  })

  it('enrolls a given wallet only once per session (dedup)', () => {
    when(actionMock.type).thenReturn('order/addPendingOrder')
    when(actionMock.payload).thenReturn({ chainId: 1, order: { owner: '0x1111111111111111111111111111111111111111' } })

    dispatch()
    dispatch()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never breaks order dispatch even if enrollment throws synchronously', () => {
    global.fetch = (() => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    when(actionMock.type).thenReturn('order/addPendingOrder')
    when(actionMock.payload).thenReturn({ chainId: 1, order: { owner: '0x2222222222222222222222222222222222222222' } })

    expect(() => dispatch()).not.toThrow()
    expect(nextMock).toHaveBeenCalledTimes(1)
  })

  it('retries on a later order when the server responds non-OK (e.g. 429/500)', async () => {
    fetchMock.mockResolvedValue({ ok: false })
    when(actionMock.type).thenReturn('order/addPendingOrder')
    when(actionMock.payload).thenReturn({ chainId: 1, order: { owner: '0x3333333333333333333333333333333333333333' } })

    dispatch()
    await flushMicrotasks() // let the non-OK response drop the address from the set
    dispatch()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
