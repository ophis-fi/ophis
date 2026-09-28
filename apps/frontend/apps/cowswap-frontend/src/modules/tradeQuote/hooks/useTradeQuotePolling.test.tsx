import { useStore } from 'jotai'
import { ReactNode } from 'react'

import { USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { useIsWindowVisible } from '@cowprotocol/common-hooks'
import { OrderKind, QuoteAndPost } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, Token } from '@cowprotocol/currency'
import { WalletInfo, walletInfoAtom } from '@cowprotocol/wallet'

import { act, renderHook, waitFor } from '@testing-library/react'
import { JotaiTestProvider, WithMockedWeb3 } from 'test-utils'
import { bridgingSdk } from 'tradingSdk/bridgingSdk'

import { LimitOrdersDerivedState, limitOrdersDerivedStateAtom } from 'modules/limitOrders/state/limitOrdersRawStateAtom'
import { DEFAULT_TRADE_DERIVED_STATE, TradeType } from 'modules/trade'
import { shouldHideQuoteAmountsAtom } from 'modules/trade/state/shouldHideQuoteAmounts.atom'

import { useEnoughAllowance } from 'common/hooks/useEnoughAllowance'

import { useTradeQuotePolling } from './useTradeQuotePolling'

import { tradeTypeAtom } from '../../trade/state/tradeTypeAtom'
import { currentTradeQuoteAtom, updateTradeQuoteAtom } from '../state/tradeQuoteAtom'
import { tradeQuoteInputAtom } from '../state/tradeQuoteInputAtom'

jest.mock('modules/zeroApproval/hooks/useZeroApprovalState')
jest.mock('common/hooks/useGetMarketDimension')
jest.mock('common/hooks/useEnoughAllowance', () => ({
  ...jest.requireActual('common/hooks/useEnoughAllowance'),
  useEnoughAllowance: jest.fn().mockReturnValue(undefined),
}))
jest.mock('@cowprotocol/common-hooks', () => ({
  ...jest.requireActual('@cowprotocol/common-hooks'),
  useIsWindowVisible: jest.fn().mockReturnValue(true),
}))
jest.mock('@cowprotocol/wallet-provider', () => ({
  ...jest.requireActual('@cowprotocol/wallet-provider'),
  useWalletChainId: jest.fn().mockReturnValue(1),
  useWalletProvider: jest.fn().mockReturnValue({
    provider: {},
    getSigner() {
      return {}
    },
  }),
}))

// Deterministic bridge-quote signer: the real module generates (and persists) a
// random key per browser, which would make the request snapshots below
// non-reproducible. Same fixture key as upstream cowswap's test.
jest.mock('../utils/getBridgeQuoteSigner', () => {
  const { Wallet } = jest.requireActual('@ethersproject/wallet') as typeof import('@ethersproject/wallet')
  const bridgeQuoteSigner = new Wallet('0x1111111111111111111111111111111111111111111111111111111111111111')

  return {
    BRIDGE_QUOTE_ACCOUNT: bridgeQuoteSigner.address,
    getBridgeQuoteSigner: jest.fn().mockReturnValue(bridgeQuoteSigner),
  }
})

jest.mock('tradingSdk/bridgingSdk', () => ({
  bridgingSdk: {
    getQuote: jest.fn(),
    getBestQuote: jest.fn(),
  },
}))

const useEnoughAllowanceMock = useEnoughAllowance as jest.Mock

const bridgingSdkMock = bridgingSdk as unknown as { getQuote: jest.Mock; getBestQuote: jest.Mock }

const inputCurrencyAmount = CurrencyAmount.fromRawAmount(WETH_MAINNET, 10_000_000)
const outputCurrencyAmount = CurrencyAmount.fromRawAmount(USDC_MAINNET, 2_000_000)

const walletInfoMock: WalletInfo = {
  chainId: 1,
  account: '0x333333f332a06ecb5d20d35da44ba07986d6e203',
  active: true,
}

const limitOrdersDerivedStateMock: LimitOrdersDerivedState = {
  ...DEFAULT_TRADE_DERIVED_STATE,
  inputCurrency: inputCurrencyAmount.currency,
  outputCurrency: outputCurrencyAmount.currency,
  inputCurrencyAmount,
  outputCurrencyAmount,
  isUnlocked: true,
}

const jotaiMock = [
  [tradeQuoteInputAtom, { amount: inputCurrencyAmount, orderKind: OrderKind.SELL }],
  [limitOrdersDerivedStateAtom, limitOrdersDerivedStateMock],
  [tradeTypeAtom, { tradeType: TradeType.LIMIT_ORDER, route: '' }],
]

const Wrapper =
  // TODO: Replace any with proper type definitions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mocks: any) =>
    ({ children }: { children: ReactNode }) => (
      <WithMockedWeb3 location={{ pathname: '/1/limit' }}>
        <JotaiTestProvider initialValues={mocks}>{children}</JotaiTestProvider>
      </WithMockedWeb3>
    )

describe('useTradeQuotePolling()', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(useIsWindowVisible).mockReturnValue(true)

    bridgingSdkMock.getQuote.mockImplementation(() => new Promise(() => void 0))
    bridgingSdkMock.getBestQuote.mockImplementation(() => new Promise(() => void 0))

    useEnoughAllowanceMock.mockReturnValue(true)
  })

  it('does not restart the same pending quote when the tab becomes visible again', async () => {
    const { rerender } = renderHook(
      () => useTradeQuotePolling({ isConfirmOpen: false, isQuoteUpdatePossible: true, useSuggestedSlippageApi: false }),
      { wrapper: Wrapper([...jotaiMock, [walletInfoAtom, walletInfoMock]]) },
    )
    await waitFor(() => expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(1))
    jest.mocked(useIsWindowVisible).mockReturnValue(false)
    rerender()
    expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(1)
    jest.mocked(useIsWindowVisible).mockReturnValue(true)
    rerender()
    expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(1)
  })

  it.each(['amount', 'account', 'token', 'chain'])('replaces a pending quote when the %s changes', async (field) => {
    const { result } = renderHook(
      () => {
        useTradeQuotePolling({ isConfirmOpen: false, isQuoteUpdatePossible: true, useSuggestedSlippageApi: false })
        return useStore()
      },
      { wrapper: Wrapper([...jotaiMock, [walletInfoAtom, walletInfoMock]]) },
    )
    await waitFor(() => expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(1))
    act(() => {
      if (field === 'amount') {
        result.current.set(tradeQuoteInputAtom, {
          amount: CurrencyAmount.fromRawAmount(WETH_MAINNET, 20_000_000),
          orderKind: OrderKind.SELL,
        })
      } else if (field === 'account') {
        result.current.set(walletInfoAtom, { ...walletInfoMock, account: '0x0000000000000000000000000000000000000001' })
      } else if (field === 'token') {
        result.current.set(limitOrdersDerivedStateAtom, {
          ...limitOrdersDerivedStateMock,
          inputCurrency: USDC_MAINNET,
          outputCurrency: WETH_MAINNET,
        })
      } else {
        result.current.set(limitOrdersDerivedStateAtom, {
          ...limitOrdersDerivedStateMock,
          outputCurrency: new Token(100, USDC_MAINNET.address, 6),
        })
      }
    })
    await waitFor(() =>
      expect(bridgingSdkMock[field === 'chain' ? 'getBestQuote' : 'getQuote']).toHaveBeenCalledTimes(
        field === 'chain' ? 1 : 2,
      ),
    )
  })

  it.each([
    { outcome: 'resolve', confirm: false },
    { outcome: 'reject', confirm: false },
    { outcome: 'reject', confirm: true },
  ])(
    'expires a pending quote and handles $outcome with confirm=$confirm without a rapid retry loop',
    async ({ outcome, confirm }) => {
      jest.useFakeTimers()
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      let resolveQuote: (quote: QuoteAndPost) => void = () => {
        throw new Error('Request not started')
      }
      let rejectQuote: (error: Error) => void = () => {
        throw new Error('Request not started')
      }
      bridgingSdkMock.getQuote.mockImplementation(
        () =>
          new Promise<QuoteAndPost>((resolve, reject) => {
            resolveQuote = resolve
            rejectQuote = reject
          }),
      )
      const makeQuote = (seconds: number): QuoteAndPost =>
        ({
          quoteResults: {
            appDataInfo: {},
            tradeParameters: { validFor: 1800 },
            quoteResponse: {
              expiration: new Date(Date.now() + seconds * 1000).toISOString(),
              quote: { validTo: Math.ceil(Date.now() / 1000) + 1800 },
            },
          },
        }) as QuoteAndPost
      const { result, unmount, rerender } = renderHook(
        ({ isConfirmOpen }) => {
          useTradeQuotePolling({ isConfirmOpen, isQuoteUpdatePossible: true, useSuggestedSlippageApi: false })
          return useStore()
        },
        { initialProps: { isConfirmOpen: false }, wrapper: Wrapper([...jotaiMock, [walletInfoAtom, walletInfoMock]]) },
      )
      try {
        await waitFor(() => expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(1))
        const original = makeQuote(4)
        act(() =>
          result.current.set(updateTradeQuoteAtom, WETH_MAINNET.address, {
            quote: original,
            hasParamsChanged: false,
            isLoading: true,
          }),
        )
        expect(result.current.get(shouldHideQuoteAmountsAtom)).toBe(false)
        rerender({ isConfirmOpen: confirm })
        await act(async () => {
          await jest.advanceTimersByTimeAsync(6000)
        })
        expect(result.current.get(currentTradeQuoteAtom)).toMatchObject({
          quote: confirm ? original : null,
          isLoading: true,
        })
        if (!confirm) expect(result.current.get(shouldHideQuoteAmountsAtom)).toBe(true)
        expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(1)
        const replacement = makeQuote(60)
        await act(async () => {
          if (outcome === 'resolve') resolveQuote(replacement)
          else rejectQuote(new Error('429 Too Many Requests'))
        })
        expect(result.current.get(currentTradeQuoteAtom).isLoading).toBe(false)
        expect(result.current.get(currentTradeQuoteAtom).quote).toBe(
          outcome === 'resolve' ? replacement : confirm ? original : null,
        )
        for (let second = 0; second < 30; second++) {
          await act(async () => {
            await jest.advanceTimersByTimeAsync(1000)
          })
          expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(1)
        }
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1000)
        })
        expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(2)
      } finally {
        unmount()
        consoleError.mockRestore()
        jest.useRealTimers()
      }
    },
  )

  describe('When wallet is connected', () => {
    it('Then should put account address into "receiver" field in the quote request', async () => {
      // Arrange
      const mocks = [...jotaiMock, [walletInfoAtom, walletInfoMock]]

      // Act
      renderHook(
        () => {
          return useTradeQuotePolling({
            isConfirmOpen: false,
            isQuoteUpdatePossible: true,
            useSuggestedSlippageApi: false,
          })
        },
        { wrapper: Wrapper(mocks) },
      )

      // Wait for Web3ReactProvider to finish initializing and getQuote to be called
      await waitFor(() => {
        expect(bridgingSdkMock.getQuote).toHaveBeenCalled()
      })

      // Assert
      const callParams = bridgingSdkMock.getQuote.mock.calls[0]

      expect(callParams[0].receiver).toBe(walletInfoMock.account) // useAddress field value
      expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(1)
      expect(callParams).toMatchSnapshot()
    })
  })

  describe('When wallet is NOT connected', () => {
    it('Then the "receiver" field in the quote request should be undefined', async () => {
      // Arrange
      const mocks = [...jotaiMock, [walletInfoAtom, { ...walletInfoMock, account: undefined }]]

      // Act
      renderHook(
        () =>
          useTradeQuotePolling({
            isConfirmOpen: false,
            isQuoteUpdatePossible: true,
            useSuggestedSlippageApi: false,
          }),
        { wrapper: Wrapper(mocks) },
      )

      // Wait for Web3ReactProvider to finish initializing and getQuote to be called
      await waitFor(() => {
        expect(bridgingSdkMock.getQuote).toHaveBeenCalled()
      })

      // Assert
      const { signer: _, ...callParams } = bridgingSdkMock.getQuote.mock.calls[0][0]

      expect(callParams.receiver).toBe(undefined) // useAddress field value
      expect(bridgingSdkMock.getQuote).toHaveBeenCalledTimes(1)
      expect(callParams).toMatchSnapshot()
    })
  })
})
