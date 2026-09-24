import { ReactElement, ReactNode } from 'react'

import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { useWalletInfo } from '@cowprotocol/wallet'

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { mobileSwapTheme } from 'ophis/mobile/mobileSwapTheme.constants'
import { ThemeProvider } from 'styled-components/macro'

import { useConfirmTradeWithRwaCheck } from 'modules/trade'

import { useCreateTwapOrder } from '../../hooks/useCreateTwapOrder'
import { useTwapFormState } from '../../hooks/useTwapFormState'
import { ActionButtons } from '../ActionButtons'

import { TwapConfirmModal } from '.'

jest.mock('react-inlinesvg', () => () => null)
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: jest.fn(),
  useWalletDetails: () => ({ allowsOffchainSigning: true }),
  useIsTxBundlingSupported: () => true,
}))
jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useAtomValue: (atom: string) =>
    atom === 'settings' ? { numberOfPartsValue: 1 } : atom === 'interval' ? 1000000 : null,
}))
jest.mock('../../state/twapOrderAtom', () => ({ twapTimeIntervalAtom: 'interval' }))
jest.mock('../../state/twapOrdersSettingsAtom', () => ({ twapOrdersSettingsAtom: 'settings' }))
jest.mock('modules/usdAmount', () => ({ useUsdAmount: () => ({ value: null }) }))
jest.mock('modules/advancedOrders', () => ({ useAdvancedOrdersDerivedState: () => ({}) }))
jest.mock('modules/trade', () => ({
  useConfirmTradeWithRwaCheck: jest.fn(),
  useGetReceiveAmountInfo: () => null,
  useCommonTradeConfirmContext: () => ({}),
  useTradeConfirmActions: () => ({ onDismiss: jest.fn() }),
  useTradePriceImpact: () => null,
  TradeConfirmModal: ({ children }: { children: ReactNode }) => <>{children}</>,
  // Preserve the confirmation component's disabled/onConfirm contract while
  // isolating unrelated pricing and wallet UI from this chain-gating test.
  TradeConfirmation: ({ isConfirmDisabled, onConfirm }: { isConfirmDisabled: boolean; onConfirm: () => void }) => (
    <button disabled={isConfirmDisabled} onClick={onConfirm}>
      Place TWAP order
    </button>
  ),
}))
jest.mock('modules/tradeFormValidation', () => ({
  XSTOCK_MIN_TRADE_SIZE_USD: 1,
  tradeFormValidationContextAtom: 'validation',
  useTradeFormButtonContext: (_title: string, confirmTrade: () => void) => ({ confirmTrade }),
  TradeFormButtons: ({ context }: { context: { confirmTrade: () => void } }) => (
    <button onClick={context.confirmTrade}>Review TWAP order</button>
  ),
}))
jest.mock('modules/trade/containers/TradeBasicConfirmDetails', () => ({ TradeBasicConfirmDetails: () => null }))
jest.mock('common/hooks/useRateInfoParams', () => ({ useRateInfoParams: () => null }))
jest.mock('common/pure/NetworkCostsSuffix', () => ({ NetworkCostsSuffix: () => null }))
jest.mock('./TwapConfirmDetails', () => ({ TwapConfirmDetails: () => null }))
jest.mock('../TwapFormWarnings', () => ({ TwapFormWarnings: () => null }))
jest.mock('../../hooks/useCreateTwapOrder', () => ({ useCreateTwapOrder: jest.fn() }))
jest.mock('../../hooks/useFallbackHandlerVerification', () => ({
  useFallbackHandlerVerification: () => 'HAS_DOMAIN_VERIFIER',
  useIsFallbackHandlerRequired: () => false,
}))
jest.mock('../../hooks/useScaledReceiveAmountInfo', () => ({ useScaledReceiveAmountInfo: () => null }))
jest.mock('../../hooks/useTwapOrder', () => ({ useTwapOrder: () => null }))
jest.mock('../../hooks/useTwapSlippage', () => ({ useTwapSlippage: () => null }))
jest.mock('../../hooks/useTwapWarningsContext', () => ({
  useTwapWarningsContext: () => ({ walletIsNotConnected: false }),
}))
jest.mock('../../hooks/useAreWarningsAccepted', () => ({ useAreWarningsAccepted: () => true }))

function DirectTwapPage(): ReactElement {
  const localFormValidation = useTwapFormState()
  return (
    <I18nProvider i18n={i18n}>
      <ThemeProvider theme={mobileSwapTheme}>
        <ActionButtons
          localFormValidation={localFormValidation}
          primaryFormValidation={null}
          fallbackHandlerIsNotSet={false}
        />
        <TwapConfirmModal />
      </ThemeProvider>
    </I18nProvider>
  )
}

it('blocks review and an already-open confirmation on Arc, and restores supported-chain actions', () => {
  const review = jest.fn()
  const createOrder = jest.fn()
  jest.mocked(useWalletInfo).mockReturnValue({ chainId: ARC_CHAIN_ID } as ReturnType<typeof useWalletInfo>)
  jest.mocked(useConfirmTradeWithRwaCheck).mockReturnValue({ confirmTrade: review })
  jest.mocked(useCreateTwapOrder).mockReturnValue(createOrder)

  const { rerender } = render(<DirectTwapPage />)
  const blocked = screen.getByRole('button', { name: 'TWAP is unavailable on this network' })
  expect(blocked.hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Review TWAP order' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Place TWAP order' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(blocked)
  fireEvent.click(screen.getByRole('button', { name: 'Place TWAP order' }))
  expect(review).not.toHaveBeenCalled()
  expect(createOrder).not.toHaveBeenCalled()

  jest.mocked(useWalletInfo).mockReturnValue({ chainId: 1 } as ReturnType<typeof useWalletInfo>)
  rerender(<DirectTwapPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Review TWAP order' }))
  expect(review).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Place TWAP order' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Place TWAP order' }))
  expect(createOrder).toHaveBeenCalledWith(false)
})
