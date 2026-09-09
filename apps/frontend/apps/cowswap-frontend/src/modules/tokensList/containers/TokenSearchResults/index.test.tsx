import { TokenWithLogo } from '@cowprotocol/common-const'
import { AdditionalTargetChainId } from '@cowprotocol/cow-sdk'
import { useSearchToken } from '@cowprotocol/tokens'

import { render } from '@testing-library/react'

import { useTokenListContext } from '../../hooks/useTokenListContext'
import { useTokenListViewState } from '../../hooks/useTokenListViewState'
import { TokenSearchContent } from '../../pure/TokenSearchContent'

import { TokenSearchResults } from './index'

jest.mock('@cowprotocol/tokens', () => ({ ...jest.requireActual('@cowprotocol/tokens'), useSearchToken: jest.fn() }))
jest.mock('modules/injectedWidget', () => ({ useInjectedWidgetParams: () => ({}) }))
jest.mock('../../hooks/useTokenListContext', () => ({ useTokenListContext: jest.fn() }))
jest.mock('../../hooks/useTokenListViewState', () => ({ useTokenListViewState: jest.fn() }))
jest.mock('../../hooks/useSelectTokenWidgetState', () => ({ useSelectTokenWidgetState: () => ({ field: 'OUTPUT' }) }))
jest.mock('../../hooks/useUpdateSelectTokenWidgetState', () => ({ useUpdateSelectTokenWidgetState: () => jest.fn() }))
jest.mock('../../hooks/useAddTokenImportCallback', () => ({ useAddTokenImportCallback: () => jest.fn() }))
jest.mock('../../pure/TokenSearchContent', () => ({ TokenSearchContent: jest.fn(() => null) }))

const USDC = new TokenWithLogo(
  undefined,
  AdditionalTargetChainId.SOLANA,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  6,
  'USDC',
  'USD Coin',
)
const ETHEREUM_USDC = new TokenWithLogo(
  undefined,
  1,
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  6,
  'USDC',
  'USD Coin',
)

function search(query: string, bridge = true, loading = false): void {
  jest.mocked(useTokenListViewState).mockReturnValue({ searchInput: query } as ReturnType<typeof useTokenListViewState>)
  jest.mocked(useTokenListContext).mockReturnValue({
    selectTokenContext: {},
    areTokensFromBridge: bridge,
    areTokensLoading: loading,
    allTokens: loading ? [] : [USDC],
    bridgeSupportedTokensMap: loading ? null : { [USDC.address]: true },
  } as ReturnType<typeof useTokenListContext>)
  render(<TokenSearchResults />)
}

function results(): Parameters<typeof TokenSearchContent>[0]['searchResults'] | undefined {
  return jest.mocked(TokenSearchContent).mock.calls.at(-1)?.[0].searchResults
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useSearchToken).mockReturnValue({
    isLoading: false,
    activeListsResult: [ETHEREUM_USDC],
    inactiveListsResult: [ETHEREUM_USDC],
    blockchainResult: [ETHEREUM_USDC],
    externalApiResult: [ETHEREUM_USDC],
  })
})

it('searches only supported destination tokens, excluding every wallet-chain search source', () => {
  search('USDC')
  expect(useSearchToken).toHaveBeenCalledWith(null)
  expect(results()).toEqual({
    isLoading: false,
    activeListsResult: [USDC],
    inactiveListsResult: [],
    blockchainResult: [],
    externalApiResult: [],
  })
})

it('finds a Solana mint without changing its case', () => {
  search(USDC.address)
  expect(results()?.activeListsResult).toEqual([USDC])
})

it('does not match a differently cased Solana mint', () => {
  search(USDC.address.toLowerCase())
  expect(results()?.activeListsResult).toEqual([])
})

it('shows no unsupported matches while destination support is loading', () => {
  search('USDC', true, true)
  expect(results()?.isLoading).toBe(true)
  expect(results()?.activeListsResult).toEqual([])
})

it('keeps normal same-chain search results', () => {
  search('USDC', false)
  expect(useSearchToken).toHaveBeenCalledWith('USDC')
  expect(results()?.activeListsResult).toEqual([ETHEREUM_USDC])
  expect(results()?.inactiveListsResult).toEqual([ETHEREUM_USDC])
})
