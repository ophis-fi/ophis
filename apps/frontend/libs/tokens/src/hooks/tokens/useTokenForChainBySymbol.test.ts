import { getAddress } from '@ethersproject/address'

import { NATIVE_CURRENCY_ADDRESS, TokenWithLogo } from '@cowprotocol/common-const'

import { enabledTokensByAddressForChain, symbolToAddressResolver, tokenBySymbolMap } from './useTokenForChainBySymbol'
import { ListState } from '../../types'

// Real mainnet addresses, intentionally lowercased so the checksum step is exercised.
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

function tok(address: string, symbol: string | undefined, chainId = 1): TokenWithLogo {
  return new TokenWithLogo(undefined, chainId, address, 18, symbol, symbol)
}

// Mirrors useTokensByAddressMapForChain: a Record keyed by lowercase address,
// whose value-iteration order is the priority order (first writer wins).
function byAddress(...tokens: TokenWithLogo[]): Record<string, TokenWithLogo> {
  const m: Record<string, TokenWithLogo> = {}
  for (const t of tokens) m[t.address.toLowerCase()] = t
  return m
}

function tokenInfo(address: string, symbol: string, chainId = 1) {
  return { chainId, address, symbol, decimals: 18, name: symbol }
}
function listState(tokens: ReturnType<typeof tokenInfo>[], priority: number, isEnabled?: boolean): ListState {
  return { source: `s${priority}`, priority, isEnabled, list: { tokens } } as unknown as ListState
}

describe('enabledTokensByAddressForChain', () => {
  it('builds a by-address map for the chain, keyed lowercase', () => {
    const m = enabledTokensByAddressForChain({ a: listState([tokenInfo(USDC, 'USDC')], 0, true) }, 1)
    expect(m[USDC.toLowerCase()]?.symbol).toBe('USDC')
  })

  it('skips a list the user disabled, so a lower-priority enabled list wins', () => {
    const DIS = '0x1111111111111111111111111111111111111111'
    const chainLists = {
      hi: listState([tokenInfo(DIS, 'USDC')], 0, false), // higher priority but DISABLED
      lo: listState([tokenInfo(USDC, 'USDC')], 1, true), // lower priority but ENABLED
    }
    const m = enabledTokensByAddressForChain(chainLists, 1)
    expect(m[DIS.toLowerCase()]).toBeUndefined()
    expect(m[USDC.toLowerCase()]?.symbol).toBe('USDC')
  })

  it('falls back to enabledByDefault when isEnabled is undefined', () => {
    // listState(..., priority 0) gets source 's0'.
    const onList = { a: listState([tokenInfo(USDC, 'USDC')], 0, undefined) }
    // default-ON source -> included
    expect(enabledTokensByAddressForChain(onList, 1, { s0: true })[USDC.toLowerCase()]).toBeDefined()
    // default-OFF source -> excluded (matches listsEnabledStateAtom semantics)
    expect(enabledTokensByAddressForChain(onList, 1, { s0: false })[USDC.toLowerCase()]).toBeUndefined()
    // unknown source (no default supplied) -> treated as off
    expect(enabledTokensByAddressForChain(onList, 1, {})[USDC.toLowerCase()]).toBeUndefined()
  })

  it('filters tokens by chainId and skips the native sentinel + deleted lists', () => {
    const chainLists = {
      a: listState(
        [tokenInfo(USDC, 'USDC', 1), tokenInfo(DAI, 'DAI', 137), tokenInfo(NATIVE_CURRENCY_ADDRESS, 'ETH', 1)],
        0,
        true,
      ),
      b: 'deleted' as const,
    }
    const m = enabledTokensByAddressForChain(chainLists, 1)
    expect(m[USDC.toLowerCase()]).toBeDefined()
    expect(m[DAI.toLowerCase()]).toBeUndefined() // wrong chain
    expect(m[NATIVE_CURRENCY_ADDRESS.toLowerCase()]).toBeUndefined() // native sentinel skipped
  })

  it('returns {} for undefined chainLists', () => {
    expect(enabledTokensByAddressForChain(undefined, 1)).toEqual({})
  })
})

describe('tokenBySymbolMap', () => {
  it('keys tokens by lowercase symbol', () => {
    const m = tokenBySymbolMap(byAddress(tok(USDC, 'USDC'), tok(DAI, 'DAI')))
    expect(m['usdc']?.address).toBe(USDC)
    expect(m['dai']?.address).toBe(DAI)
  })

  it('first (priority-ordered) token wins on a duplicate symbol', () => {
    const first = tok(USDC, 'USDC')
    const second = tok('0x1111111111111111111111111111111111111111', 'USDC')
    const m = tokenBySymbolMap(byAddress(first, second))
    expect(m['usdc']?.address).toBe(first.address)
  })

  it('skips tokens without a symbol', () => {
    const m = tokenBySymbolMap(byAddress(tok(USDC, undefined)))
    expect(Object.keys(m)).toHaveLength(0)
  })

  it('injects wrapped native when its symbol is absent from the lists', () => {
    const wrapped = tok(WETH, 'WETH')
    const m = tokenBySymbolMap(byAddress(tok(USDC, 'USDC')), undefined, wrapped)
    expect(m['weth']?.address).toBe(WETH)
  })

  it('does not override a list WETH already present with the wrapped const', () => {
    const listWeth = tok(WETH, 'WETH')
    const constWeth = tok('0x2222222222222222222222222222222222222222', 'WETH')
    const m = tokenBySymbolMap(byAddress(listWeth), undefined, constWeth)
    expect(m['weth']?.address).toBe(listWeth.address)
  })

  it('native currency wins its own symbol (ETH -> sentinel)', () => {
    const native = tok(NATIVE_CURRENCY_ADDRESS, 'ETH')
    const listEth = tok('0x3333333333333333333333333333333333333333', 'ETH')
    const m = tokenBySymbolMap(byAddress(listEth), native, undefined)
    expect(m['eth']?.address).toBe(NATIVE_CURRENCY_ADDRESS)
  })
})

describe('symbolToAddressResolver', () => {
  const map = tokenBySymbolMap(byAddress(tok(USDC, 'USDC')), tok(NATIVE_CURRENCY_ADDRESS, 'ETH'), tok(WETH, 'WETH'))
  const resolve = symbolToAddressResolver(map)

  it('resolves a known symbol to its checksummed address, case-insensitively', () => {
    expect(resolve('usdc')).toBe(getAddress(USDC))
    expect(resolve('USDC')).toBe(getAddress(USDC))
    // proves the emitted value is EIP-55 checksummed, not the lowercase input
    expect(resolve('usdc')).not.toBe(USDC)
  })

  it('resolves native ETH to the checksummed sentinel address', () => {
    expect(resolve('eth')).toBe(getAddress(NATIVE_CURRENCY_ADDRESS))
  })

  it('returns null for an unknown symbol', () => {
    expect(resolve('nope')).toBeNull()
  })

  it('returns null for an empty symbol', () => {
    expect(resolve('')).toBeNull()
  })
})
