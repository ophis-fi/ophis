/**
 * useIntentParse HTTP status branching (Phase 3 audit M).
 *
 * Pre-fix the hook went straight to res.json() without status checks,
 * collapsing every failure to code='UPSTREAM' message='network error'.
 * These tests pin the new status→code mapping so a refactor can't
 * silently regress the UX.
 */
import { act, renderHook, waitFor } from '@testing-library/react'

import { useIntentParse } from './useIntentParse'

const realFetch = globalThis.fetch

function mockFetchOnce(init: { status: number; body?: unknown; bodyText?: string; statusText?: string }) {
  const headers = new Headers()
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const body = init.bodyText !== undefined ? init.bodyText : init.body !== undefined ? JSON.stringify(init.body) : ''
  ;(globalThis.fetch as unknown) = jest.fn(() =>
    Promise.resolve(new Response(body, { status: init.status, statusText: init.statusText, headers })),
  )
}

describe('useIntentParse HTTP status branching', () => {
  afterEach(() => {
    jest.useRealTimers()
    ;(globalThis.fetch as unknown) = realFetch
  })

  // Drive past the 400ms debounce + microtask queue.
  async function advance() {
    await act(async () => {
      jest.advanceTimersByTime(500)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('maps HTTP 429 to RATE_LIMITED', async () => {
    jest.useFakeTimers()
    mockFetchOnce({ status: 429, bodyText: 'rate limited' })
    const { result } = renderHook(() => useIntentParse('swap 100 USDC for ETH'))
    await advance()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorCode).toBe('RATE_LIMITED')
  })

  it('maps HTTP 403 to FORBIDDEN', async () => {
    jest.useFakeTimers()
    mockFetchOnce({ status: 403, bodyText: 'blocked' })
    const { result } = renderHook(() => useIntentParse('swap 100 USDC for ETH'))
    await advance()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorCode).toBe('FORBIDDEN')
  })

  it('maps HTTP 504 to TIMEOUT', async () => {
    jest.useFakeTimers()
    mockFetchOnce({ status: 504, bodyText: 'upstream timed out' })
    const { result } = renderHook(() => useIntentParse('swap 100 USDC for ETH'))
    await advance()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorCode).toBe('TIMEOUT')
  })

  it('maps HTTP 500 to UPSTREAM (not generic network error)', async () => {
    jest.useFakeTimers()
    mockFetchOnce({ status: 500, bodyText: '<html>worker crashed</html>' })
    const { result } = renderHook(() => useIntentParse('swap 100 USDC for ETH'))
    await advance()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorCode).toBe('UPSTREAM')
    expect(result.current.errorMessage).toMatch(/parser unavailable/)
  })

  it('maps HTTP 400 to BAD_INPUT', async () => {
    jest.useFakeTimers()
    mockFetchOnce({ status: 400, bodyText: 'bad text' })
    const { result } = renderHook(() => useIntentParse('swap 100 USDC for ETH'))
    await advance()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorCode).toBe('BAD_INPUT')
  })

  it('prefers structured body error.code when available', async () => {
    jest.useFakeTimers()
    mockFetchOnce({
      status: 400,
      body: { ok: false, error: { code: 'INVALID_JSON', message: 'parser produced non-JSON' } },
    })
    const { result } = renderHook(() => useIntentParse('swap 100 USDC for ETH'))
    await advance()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorCode).toBe('INVALID_JSON')
    expect(result.current.errorMessage).toBe('parser produced non-JSON')
  })

  it('maps 200 with non-JSON body to INVALID_JSON (not UPSTREAM)', async () => {
    jest.useFakeTimers()
    ;(globalThis.fetch as unknown) = jest.fn(() =>
      Promise.resolve(new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })),
    )
    const { result } = renderHook(() => useIntentParse('swap 100 USDC for ETH'))
    await advance()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.errorCode).toBe('INVALID_JSON')
  })

  it('parses a 200 ok:true body normally', async () => {
    jest.useFakeTimers()
    mockFetchOnce({
      status: 200,
      body: { ok: true, data: { intent: 'swap', entities: [] } },
    })
    const { result } = renderHook(() => useIntentParse('swap 100 USDC for ETH'))
    await advance()
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.parsed).toEqual({ intent: 'swap', entities: [] })
  })
})
