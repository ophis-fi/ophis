import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

it('keeps identical tickers separate by contract, including impersonations of a fee asset', async () => {
  vi.resetModules()
  vi.stubGlobal('location', new URL('http://localhost/?chainId=56'))
  const { registerToken, tokenFor, tokenIdFor, TOKENS } = await import('./config')
  const { feeTokenFor, usesBoundWithdrawal } = await import('./fee-asset')
  const first = registerToken({ address: '0x0000000000000000000000000000000000001234', symbol: 'WBNB', decimals: 8 })
  const second = registerToken({ address: '0x0000000000000000000000000000000000005678', symbol: 'WBNB', decimals: 6 })
  expect(first).not.toBe(second)
  expect(tokenFor(first).decimals).toBe(8)
  expect(tokenFor(second).decimals).toBe(6)
  expect(tokenIdFor(TOKENS.WBNB.address.toLowerCase())).toBe('WBNB')
  expect(tokenFor('WBNB').decimals).toBe(18)
  expect(feeTokenFor(first)).toBe('WBNB')
  expect(usesBoundWithdrawal(first)).toBe(true)
  expect(usesBoundWithdrawal('WBNB')).toBe(false)
  expect(usesBoundWithdrawal('WBNB', true)).toBe(true)
  expect(() => registerToken({ ...tokenFor(first), decimals: 18 })).toThrow(/decimals changed/)
})

it('quotes additional tokens through bounded routes and preserves exact token precision', async () => {
  vi.resetModules()
  vi.stubGlobal('location', new URL('http://localhost/?chainId=56'))
  const { registerToken } = await import('./config')
  const { amountFromInput } = await import('./recipe')
  const { routeCandidates } = await import('./routes')
  const token = registerToken({ address: '0x0000000000000000000000000000000000001234', symbol: 'BTCB', decimals: 8 })
  expect(amountFromInput('1.00000001', token)).toBe(100_000_001n)
  expect(() => amountFromInput('0.000000001', token)).toThrow()
  const before = routeCandidates(token, 'USDC')
  for (let i = 0; i < 100; i++) registerToken({ address: `0x${(100_000 + i).toString(16).padStart(40, '0')}`, symbol: 'CUSTOM', decimals: 18 })
  expect(routeCandidates(token, 'USDC')).toEqual(before)
  expect(before).toHaveLength(36)
  expect(before.every(route => route.tokens[0] === token && route.tokens.at(-1) === 'USDC')).toBe(true)
})

it('rejects invalid metadata before allowing an address to be selected', async () => {
  vi.resetModules()
  const { registerToken, isTokenSymbol } = await import('./config')
  const address = '0x0000000000000000000000000000000000001234'
  for (const token of [
    { address: '0x0000000000000000000000000000000000000000', decimals: 18, symbol: 'X' },
    { address, decimals: -1, symbol: 'X' }, { address, decimals: 78, symbol: 'X' },
    { address, decimals: 18, symbol: '\u202eWBNB' }, { address, decimals: 18, symbol: 'US\u200bDC' }, { address, decimals: 18, symbol: '' },
  ]) expect(() => registerToken(token)).toThrow()
  expect(isTokenSymbol(address)).toBe(false)
})

it.each([1, 42161, 137, 56])('uses a known fee asset for additional principals on chain %i', async chain => {
  vi.resetModules()
  vi.stubGlobal('location', new URL(`http://localhost/?chainId=${chain}`))
  const { registerToken, WRAPPED_SYMBOL, tokenFor } = await import('./config')
  const { feeTokenFor, feeAddressFor, usesBoundWithdrawal } = await import('./fee-asset')
  const id = registerToken({ address: '0x0000000000000000000000000000000000001234', symbol: 'USDC', decimals: 8 })
  expect(feeTokenFor(id)).toBe(WRAPPED_SYMBOL)
  expect(feeAddressFor(id)).toBe(tokenFor(WRAPPED_SYMBOL).address)
  expect(usesBoundWithdrawal(id)).toBe(true)
  expect(feeTokenFor('USDC')).toBe(chain === 56 ? 'WBNB' : 'USDC')
})
