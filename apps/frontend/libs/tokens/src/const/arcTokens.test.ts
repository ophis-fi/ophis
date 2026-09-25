import { createStore } from 'jotai'

import { ARC_CHAIN_ID, ARC_CIRBTC, ARC_EURC, ARC_USDC, ARC_USYC } from '@cowprotocol/common-const'
import { getAddressKey } from '@cowprotocol/cow-sdk'
import type { TokenList } from '@uniswap/token-lists'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DEFAULT_FAVORITE_TOKENS } from './defaultFavoriteTokens'
import { OPHIS_TOKENS_LIST_SOURCE } from './tokensLists'

import { environmentAtom } from '../state/environmentAtom'
import { upsertListsAtom } from '../state/tokenLists/tokenListsActionsAtom'
import { allListsSourcesAtom, listsStatesByChainAtom } from '../state/tokenLists/tokenListsStateAtom'
import { allActiveTokensAtom } from '../state/tokens/allTokensAtom'

const shippedList = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../apps/cowswap-frontend/public/token-lists/ophis.json'), 'utf8'),
) as TokenList
const arcTokens = [ARC_USDC, ARC_EURC, ARC_CIRBTC, ARC_USYC]

it('ships all four Arc issuer tokens with the correct decimals in the list and favourites', () => {
  for (const token of arcTokens) {
    const identity = { chainId: ARC_CHAIN_ID, address: token.address, decimals: token.decimals, symbol: token.symbol }
    expect(shippedList.tokens).toContainEqual(expect.objectContaining(identity))
    expect(DEFAULT_FAVORITE_TOKENS[ARC_CHAIN_ID][getAddressKey(token.address)]).toMatchObject(identity)
  }
})

it.each([false, true])('loads Arc tokens without relying on favourites (curated=%s)', async (useCuratedListOnly) => {
  const store = createStore()
  store.set(environmentAtom, { chainId: ARC_CHAIN_ID, hideFavoriteTokens: true, useCuratedListOnly })
  store.set(listsStatesByChainAtom, {})
  const sources = store.get(allListsSourcesAtom)
  expect(sources).toEqual([expect.objectContaining({ source: OPHIS_TOKENS_LIST_SOURCE, enabledByDefault: true })])
  await store.set(upsertListsAtom, ARC_CHAIN_ID, [{ ...sources[0], list: shippedList }])
  const active = await store.get(allActiveTokensAtom)
  expect(active.tokens).toEqual(
    expect.arrayContaining(
      arcTokens.map((token) =>
        expect.objectContaining({
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
        }),
      ),
    ),
  )
})

it('ships locally hosted logos and the additional Arc trading assets', () => {
  const arc = shippedList.tokens.filter(({ chainId }) => chainId === ARC_CHAIN_ID)
  expect(arc.map(({ symbol }) => symbol).sort()).toEqual(
    expect.arrayContaining(['ARGUS', 'CRCLon', 'EURC', 'ONDO', 'USDC', 'USYC', 'WETH', 'XAUM', 'cirBTC']),
  )
  for (const token of arc.filter((token) =>
    ['USDC', 'EURC', 'cirBTC', 'USYC', 'WETH', 'XAUM', 'CRCLon', 'ONDO', 'ARGUS'].includes(token.symbol),
  )) {
    expect(token.logoURI).toMatch(/^https:\/\/swap\.ophis\.fi\/logos\//)
    const path = new URL(token.logoURI || '').pathname
    expect(readFileSync(resolve(__dirname, '../../../../apps/cowswap-frontend/public' + path)).length).toBeGreaterThan(
      0,
    )
  }
})

it('refreshes an old two-token Arc list while preserving disabled preferences', async () => {
  const store = createStore()
  store.set(environmentAtom, { chainId: ARC_CHAIN_ID, hideFavoriteTokens: true })
  const source = store.get(allListsSourcesAtom)[0]
  for (const isEnabled of [true, false]) {
    await store.set(upsertListsAtom, ARC_CHAIN_ID, [
      {
        ...source,
        isEnabled,
        list: {
          ...shippedList,
          tokens: shippedList.tokens.filter(
            (token) => token.chainId === ARC_CHAIN_ID && ['USDC', 'EURC'].includes(token.symbol),
          ),
        },
      },
    ])
    await store.set(upsertListsAtom, ARC_CHAIN_ID, [{ ...source, list: shippedList }])
    const active = await store.get(allActiveTokensAtom)
    expect(active.tokens.some((token) => token.symbol === 'cirBTC')).toBe(isEnabled)
    if (isEnabled) expect(active.tokens.length).toBeGreaterThanOrEqual(42)
  }
})
