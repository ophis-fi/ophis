import { ReactNode } from 'react'

import { CurrencyAmount, Token } from '@cowprotocol/currency'
import { BridgeStatus } from '@cowprotocol/sdk-bridging'

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'

import { ReceivedBridgingContent } from './ReceivedBridgingContent'
import { RefundedBridgingContent } from './RefundedBridgingContent'

jest.mock('modules/trade', () => ({
  ConfirmDetailsItem: ({ label, children }: { label: ReactNode; children: ReactNode }) => (
    <div>
      {label}
      {children}
    </div>
  ),
  ReceiveAmountTitle: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
jest.mock('entities/bridgeProvider', () => ({ useBridgeSupportedNetwork: () => undefined }))
jest.mock('../../TokenAmountDisplay', () => ({
  TokenAmountDisplay: ({ currencyAmount }: { currencyAmount: CurrencyAmount<Token> }) => (
    <span>{currencyAmount.toExact()}</span>
  ),
}))
jest.mock('../../BridgeTransactionLink', () => ({
  BridgeTransactionLink: ({ link }: { link: string }) => <a href={link}>View Relay transaction</a>,
}))

const token = new Token(8453, '0x1111111111111111111111111111111111111111', 6, 'USDC')
const amount = CurrencyAmount.fromRawAmount(token, '123456789')
const EXPLORER = 'https://relay.link/transaction/123'

it('confirms a Relay refund without asserting a source-chain token or full input amount', () => {
  render(
    <I18nProvider i18n={i18n}>
      <RefundedBridgingContent
        account="0x2222222222222222222222222222222222222222"
        bridgeSendCurrencyAmount={amount}
        isRelay
        explorerUrl={EXPLORER}
      />
    </I18nProvider>,
  )
  expect(screen.getByText(/Relay refund completed/)).toBeTruthy()
  expect(screen.queryByText('123.456789')).toBeNull()
  expect(screen.queryByText('USDC')).toBeNull()
  expect(screen.getByRole('link', { name: 'View Relay transaction' }).getAttribute('href')).toBe(EXPLORER)
})

it('labels Relay completion as the signed minimum instead of the actual delivered amount', () => {
  const statusResult = { status: BridgeStatus.EXECUTED, relayRecoveryRequired: false }
  render(
    <I18nProvider i18n={i18n}>
      <ReceivedBridgingContent
        statusResult={statusResult}
        sourceChainId={8453}
        destinationChainId={10}
        receivedAmount={amount}
        receivedAmountUsd={null}
        explorerUrl={EXPLORER}
      />
    </I18nProvider>,
  )
  expect(screen.getByText('Minimum received')).toBeTruthy()
  expect(screen.getByText('123.456789')).toBeTruthy()
})
