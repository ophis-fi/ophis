import { fetchTokenList } from './fetchTokenList'

import { UNISWAP_TOKENS_LIST } from '../const/tokensLists'

const list = {
  name: 'Uniswap',
  timestamp: '2026-09-10T12:00:00Z',
  version: { major: 1, minor: 0, patch: 0 },
  tokens: [
    {
      chainId: 4663,
      address: '0x39dbed3a2bd333467115de45665cc57f813c4571',
      decimals: 18,
      symbol: 'PONS',
      name: 'Pons',
    },
  ],
}

it('prefers HTTPS without changing the stored identity and falls back after an invalid response', async () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch')
  try {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => list } as Response)
    const result = await fetchTokenList({ source: UNISWAP_TOKENS_LIST, priority: 1 })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://tokens.uniswap.org',
      expect.objectContaining({ credentials: 'omit' }),
    )
    expect(result.source).toBe(UNISWAP_TOKENS_LIST)
    expect(result.list?.logoURI).toBe('https://swap.ophis.fi/logos/uniswap.svg')
    expect(result.list?.tokens[0].address).toBe('0x39dBED3a2bd333467115dE45665cC57F813C4571')

    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...list, version: null }) } as Response)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => list } as Response)
    await fetchTokenList({ source: UNISWAP_TOKENS_LIST })
    expect(fetchMock).toHaveBeenNthCalledWith(2, UNISWAP_TOKENS_LIST, expect.objectContaining({ credentials: 'omit' }))
  } finally {
    fetchMock.mockRestore()
  }
})

it('reaches the fallback when the preferred endpoint stalls', async () => {
  jest.useFakeTimers()
  const fetchMock = jest.spyOn(globalThis, 'fetch')
  try {
    fetchMock.mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')))
        }),
    )
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => list } as Response)
    const pending = fetchTokenList({ source: UNISWAP_TOKENS_LIST })
    await jest.advanceTimersByTimeAsync(30_000)
    expect((await pending).list?.tokens[0].symbol).toBe('PONS')
    expect(fetchMock).toHaveBeenNthCalledWith(2, UNISWAP_TOKENS_LIST, expect.objectContaining({ credentials: 'omit' }))
  } finally {
    fetchMock.mockRestore()
    jest.useRealTimers()
  }
})
