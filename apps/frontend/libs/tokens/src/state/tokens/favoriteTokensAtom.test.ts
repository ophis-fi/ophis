import { COW_TOKEN_TO_CHAIN } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { migrateFavoriteTokensAtomV2toV3 } from './favoriteTokensAtom'

import { TokensMap } from '../../types'

const V2 = 'favoriteTokensAtom:v2'
const V3 = 'favoriteTokensAtom:v3'

// Real on-chain COW addresses for the chains under test (filter must track these).
const COW_MAINNET = COW_TOKEN_TO_CHAIN[SupportedChainId.MAINNET]?.address as string
const COW_BASE = COW_TOKEN_TO_CHAIN[SupportedChainId.BASE]?.address as string
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function token(address: string): TokensMap[string] {
  return { chainId: 1, address, name: 'Token', decimals: 18, symbol: 'TKN', logoURI: '' }
}

function favorites(map: Record<string, string[]>): string {
  const state: Record<string, TokensMap> = {}
  for (const [chainId, addresses] of Object.entries(map)) {
    state[chainId] = addresses.reduce<TokensMap>((acc, a) => {
      acc[a.toLowerCase()] = token(a)
      return acc
    }, {})
  }
  return JSON.stringify(state)
}

describe('migrateFavoriteTokensAtomV2toV3', () => {
  beforeEach(() => localStorage.clear())

  it('preconditions: COW is deployed on the test chains', () => {
    expect(COW_MAINNET).toBeTruthy()
    expect(COW_BASE).toBeTruthy()
  })

  it('strips the COW token but preserves the rest of the v2 selection', () => {
    localStorage.setItem(V2, favorites({ [SupportedChainId.MAINNET]: [COW_MAINNET, USDC] }))

    migrateFavoriteTokensAtomV2toV3(V2, V3)

    const v3 = JSON.parse(localStorage.getItem(V3) as string)
    const mainnet = v3[SupportedChainId.MAINNET]
    expect(mainnet[COW_MAINNET.toLowerCase()]).toBeUndefined()
    expect(mainnet[USDC.toLowerCase()]).toBeDefined()
  })

  it('preserves user favorites across multiple chains', () => {
    localStorage.setItem(
      V2,
      favorites({
        [SupportedChainId.MAINNET]: [USDC],
        [SupportedChainId.BASE]: [COW_BASE, USDC],
      }),
    )

    migrateFavoriteTokensAtomV2toV3(V2, V3)

    const v3 = JSON.parse(localStorage.getItem(V3) as string)
    expect(v3[SupportedChainId.MAINNET][USDC.toLowerCase()]).toBeDefined()
    expect(v3[SupportedChainId.BASE][COW_BASE.toLowerCase()]).toBeUndefined()
    expect(v3[SupportedChainId.BASE][USDC.toLowerCase()]).toBeDefined()
  })

  it('does not overwrite an already-populated v3 (idempotent / device sync)', () => {
    localStorage.setItem(V2, favorites({ [SupportedChainId.MAINNET]: [USDC] }))
    localStorage.setItem(V3, JSON.stringify({ sentinel: true }))

    migrateFavoriteTokensAtomV2toV3(V2, V3)

    expect(JSON.parse(localStorage.getItem(V3) as string)).toEqual({ sentinel: true })
  })

  it('is a no-op when there is no v2 to migrate', () => {
    migrateFavoriteTokensAtomV2toV3(V2, V3)
    expect(localStorage.getItem(V3)).toBeNull()
  })
})
