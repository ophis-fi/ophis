import { useAtomValue } from 'jotai'

import { SUI_CHAIN_ID, TokenWithLogo } from '@cowprotocol/common-const'
import { AdditionalTargetChainId, SupportedChainId } from '@cowprotocol/cow-sdk'
import { useFavoriteTokens } from '@cowprotocol/tokens'
import { useWalletInfo, WalletInfo } from '@cowprotocol/wallet'

import { renderHook } from '@testing-library/react'
import { useBridgeSupportedTokens } from 'entities/bridgeProvider'

import { Field } from 'legacy/state/types'

import { useChainsToSelect } from './useChainsToSelect'
import { useSelectTokenWidgetState } from './useSelectTokenWidgetState'
import { useTokensToSelect } from './useTokensToSelect'

import { buildVirtualRows } from '../pure/TokensVirtualList/tokensVirtualListUtils'
import { DEFAULT_SELECT_TOKEN_WIDGET_STATE } from '../state/selectTokenWidgetAtom'
import {
  buildNextStoredTokens,
  buildTokensByKey,
  getStoredTokenKey,
  hydrateStoredToken,
  persistStoredTokens,
  readStoredTokens,
} from '../utils/recentTokensStorage'

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useAtomValue: jest.fn(),
}))

jest.mock('@cowprotocol/wallet', () => ({
  ...jest.requireActual('@cowprotocol/wallet'),
  useWalletInfo: jest.fn(),
}))

jest.mock('@cowprotocol/tokens', () => ({
  ...jest.requireActual('@cowprotocol/tokens'),
  useFavoriteTokens: jest.fn(),
}))

jest.mock('entities/bridgeProvider', () => ({
  ...jest.requireActual('entities/bridgeProvider'),
  useBridgeSupportedTokens: jest.fn(),
}))

jest.mock('./useSelectTokenWidgetState', () => ({
  useSelectTokenWidgetState: jest.fn(),
}))

jest.mock('./useChainsToSelect', () => ({
  useChainsToSelect: jest.fn(),
}))

const mockUseAtomValue = useAtomValue as jest.MockedFunction<typeof useAtomValue>
const mockUseWalletInfo = useWalletInfo as jest.MockedFunction<typeof useWalletInfo>
const mockUseFavoriteTokens = useFavoriteTokens as jest.MockedFunction<typeof useFavoriteTokens>
const mockUseBridgeSupportedTokens = useBridgeSupportedTokens as jest.MockedFunction<typeof useBridgeSupportedTokens>
const mockUseSelectTokenWidgetState = useSelectTokenWidgetState as jest.MockedFunction<typeof useSelectTokenWidgetState>
const mockUseChainsToSelect = useChainsToSelect as jest.MockedFunction<typeof useChainsToSelect>

const mainnetToken = {
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  chainId: SupportedChainId.MAINNET,
  decimals: 6,
  symbol: 'USDC',
  name: 'USD Coin',
} as TokenWithLogo

const lineaToken = {
  address: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff',
  chainId: SupportedChainId.LINEA,
  decimals: 6,
  symbol: 'USDC',
  name: 'USD Coin',
} as TokenWithLogo

type WidgetState = ReturnType<typeof useSelectTokenWidgetState>
const createWidgetState = (override: Partial<typeof DEFAULT_SELECT_TOKEN_WIDGET_STATE>): WidgetState => {
  return {
    ...DEFAULT_SELECT_TOKEN_WIDGET_STATE,
    ...override,
  } as WidgetState
}

describe('useTokensToSelect', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    mockUseAtomValue.mockReturnValue([mainnetToken])
    mockUseWalletInfo.mockReturnValue({ chainId: SupportedChainId.MAINNET } as WalletInfo)
    mockUseFavoriteTokens.mockReturnValue([])
    mockUseBridgeSupportedTokens.mockReturnValue({
      data: { tokens: [lineaToken], isRouteAvailable: true },
      isLoading: false,
    } as ReturnType<typeof useBridgeSupportedTokens>)
    mockUseChainsToSelect.mockReturnValue(undefined)
  })

  it('shows the full destination catalog before a sell token is selected', () => {
    mockUseSelectTokenWidgetState.mockReturnValue(
      createWidgetState({
        field: Field.OUTPUT,
        selectedTargetChainId: SupportedChainId.MAINNET,
      }),
    )
    mockUseChainsToSelect.mockReturnValue({
      defaultChainId: SupportedChainId.LINEA,
      chains: [],
      isLoading: false,
    })

    mockUseAtomValue.mockReturnValue([lineaToken])
    mockUseFavoriteTokens.mockReturnValue([lineaToken])
    mockUseBridgeSupportedTokens.mockReturnValue({
      data: { tokens: [], isRouteAvailable: false },
      isLoading: true,
      error: undefined,
      isValidating: true,
      mutate: jest.fn(),
    })
    const { result } = renderHook(() => useTokensToSelect())

    expect(mockUseBridgeSupportedTokens).toHaveBeenCalledWith(undefined)
    expect(result.current.areTokensFromBridge).toBe(false)
    expect(result.current.tokens).toEqual([lineaToken])
    expect(result.current.favoriteTokens).toEqual([lineaToken])
    expect(result.current.isRouteAvailable).toBeUndefined()
    expect(result.current.isLoading).toBe(false)
  })

  it('uses provider discovery for destinations without a local catalog before a sell token is selected', () => {
    const solanaChainId = 1151111081099710
    const solanaToken = { ...lineaToken, chainId: solanaChainId } as TokenWithLogo
    mockUseSelectTokenWidgetState.mockReturnValue(
      createWidgetState({ field: Field.OUTPUT, selectedTargetChainId: solanaChainId }),
    )
    mockUseBridgeSupportedTokens.mockReturnValue({
      data: { tokens: [solanaToken], isRouteAvailable: true },
      isLoading: false,
    } as ReturnType<typeof useBridgeSupportedTokens>)

    const { result } = renderHook(() => useTokensToSelect())

    expect(mockUseBridgeSupportedTokens).toHaveBeenCalledWith({
      buyChainId: solanaChainId,
      sellChainId: SupportedChainId.MAINNET,
      sellTokenAddress: undefined,
    })
    expect(result.current.areTokensFromBridge).toBe(true)
    expect(result.current.tokens).toEqual([solanaToken])
    expect(result.current.tokens).not.toContain(mainnetToken)
  })

  it('passes sellChainId/buyChainId when selecting output token on a different chain', () => {
    mockUseSelectTokenWidgetState.mockReturnValue(
      createWidgetState({
        field: Field.OUTPUT,
        selectedTargetChainId: SupportedChainId.MAINNET,
        oppositeToken: mainnetToken,
      }),
    )
    mockUseChainsToSelect.mockReturnValue({
      defaultChainId: SupportedChainId.LINEA,
      chains: [],
      isLoading: false,
    })

    renderHook(() => useTokensToSelect())

    expect(mockUseBridgeSupportedTokens).toHaveBeenCalledWith({
      buyChainId: SupportedChainId.LINEA,
      sellChainId: SupportedChainId.MAINNET,
      sellTokenAddress: mainnetToken.address,
    })
  })

  it('uses oppositeToken chainId as sellChainId when wallet network differs from trade network', () => {
    const arbitrumToken = { ...mainnetToken, chainId: SupportedChainId.ARBITRUM_ONE } as TokenWithLogo

    mockUseWalletInfo.mockReturnValue({ chainId: SupportedChainId.MAINNET } as WalletInfo)
    mockUseSelectTokenWidgetState.mockReturnValue(
      createWidgetState({
        field: Field.OUTPUT,
        selectedTargetChainId: SupportedChainId.MAINNET,
        oppositeToken: arbitrumToken, // sell token on Arbitrum, wallet on Mainnet
      }),
    )
    mockUseChainsToSelect.mockReturnValue(undefined)

    renderHook(() => useTokensToSelect())

    expect(mockUseBridgeSupportedTokens).toHaveBeenCalledWith({
      buyChainId: SupportedChainId.MAINNET,
      sellChainId: SupportedChainId.ARBITRUM_ONE,
      sellTokenAddress: mainnetToken.address,
    })
  })

  it('replaces a source-chain favorite with the matching target-chain token', () => {
    const sharedAddress = '0x4200000000000000000000000000000000000006'
    const optimismFavorite = {
      ...mainnetToken,
      address: sharedAddress,
      chainId: AdditionalTargetChainId.OPTIMISM,
      symbol: 'WETH',
    } as TokenWithLogo
    const baseBridgeToken = {
      ...optimismFavorite,
      chainId: SupportedChainId.BASE,
    } as TokenWithLogo

    mockUseFavoriteTokens.mockReturnValue([optimismFavorite])
    mockUseBridgeSupportedTokens.mockReturnValue({
      data: { tokens: [baseBridgeToken], isRouteAvailable: true },
      isLoading: false,
    } as ReturnType<typeof useBridgeSupportedTokens>)
    mockUseSelectTokenWidgetState.mockReturnValue(
      createWidgetState({
        field: Field.OUTPUT,
        selectedTargetChainId: SupportedChainId.BASE,
        oppositeToken: mainnetToken,
      }),
    )

    const { result } = renderHook(() => useTokensToSelect())

    expect(result.current.favoriteTokens).toEqual([baseBridgeToken])
    expect(result.current.favoriteTokens[0]).not.toBe(optimismFavorite)
  })

  it('shows known bridge tokens while provider discovery is still loading', () => {
    mockUseBridgeSupportedTokens.mockReturnValue({
      data: { tokens: [lineaToken], isRouteAvailable: true },
      isLoading: true,
    } as ReturnType<typeof useBridgeSupportedTokens>)
    mockUseSelectTokenWidgetState.mockReturnValue(
      createWidgetState({
        field: Field.OUTPUT,
        selectedTargetChainId: SupportedChainId.LINEA,
        oppositeToken: mainnetToken,
      }),
    )
    const { result } = renderHook(() => useTokensToSelect())
    expect(result.current.tokens).toEqual([lineaToken])
    expect(result.current.isLoading).toBe(false)
  })

  it('keeps custom picker context stable when search registers its Enter handler', () => {
    const token = new TokenWithLogo(
      undefined,
      AdditionalTargetChainId.SOLANA,
      'So11111111111111111111111111111111111111112',
      9,
      'SOL',
    )
    const state = createWidgetState({
      field: Field.INPUT,
      selectedTargetChainId: AdditionalTargetChainId.SOLANA,
      tokenOptions: { tokens: [token], chains: [] },
    })
    mockUseSelectTokenWidgetState.mockReturnValue(state)
    const { result, rerender } = renderHook(() => useTokensToSelect())
    const initial = result.current

    mockUseSelectTokenWidgetState.mockReturnValue({ ...state, onInputPressEnter: jest.fn() })
    rerender()

    expect(result.current).toBe(initial)
    expect(result.current.bridgeSupportedTokensMap).toBe(initial.bridgeSupportedTokensMap)
  })

  it.each([
    [AdditionalTargetChainId.SOLANA, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', false],
    [SUI_CHAIN_ID, '0x2::sui::SUI', false],
    [SupportedChainId.MAINNET, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', true],
  ])(
    'preserves custom token identity through recent storage and bridge rows on %s',
    (chainId, address, sameIdentity) => {
      const token = new TokenWithLogo(undefined, chainId, address, 6, 'TOKEN')
      const variant = new TokenWithLogo(undefined, chainId, address.toLowerCase(), 6, 'OTHER')
      mockUseSelectTokenWidgetState.mockReturnValue(
        createWidgetState({
          field: Field.INPUT,
          selectedTargetChainId: chainId,
          tokenOptions: { tokens: [token], chains: [] },
        }),
      )
      const { result } = renderHook(() => useTokensToSelect())
      expect(result.current.tokens).toEqual([token])
      expect(mockUseBridgeSupportedTokens).toHaveBeenCalledWith(undefined)

      const stored = buildNextStoredTokens(buildNextStoredTokens({}, token, 4), variant, 4)
      persistStoredTokens(stored)
      const reloaded = readStoredTokens(4)[chainId]
      expect(reloaded).toHaveLength(sameIdentity ? 1 : 2)
      const canonical = buildTokensByKey(result.current.tokens)
      const recentTokens = reloaded.flatMap((entry) => {
        const hydrated = hydrateStoredToken(entry, canonical.get(getStoredTokenKey(entry)))
        return hydrated ? [hydrated] : []
      })
      expect(recentTokens).toEqual(sameIdentity ? [token] : [variant, token])

      const rows = buildVirtualRows({
        sortedTokens: [],
        favoriteTokens: [],
        recentTokens,
        hideFavoriteTokensTooltip: false,
        onClearRecentTokens: jest.fn(),
        areTokensFromBridge: result.current.areTokensFromBridge,
        bridgeSupportedTokensMap: result.current.bridgeSupportedTokensMap,
      })
      expect(rows.filter((row) => row.type === 'token').map((row) => row.disabled)).toEqual(
        sameIdentity ? [false] : [true, false],
      )
    },
  )
})
