import { useIsBridgingEnabled } from '@cowprotocol/common-hooks'
import { areAddressesEqual, OrderKind } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useIsSmartContractWallet, useWalletInfo } from '@cowprotocol/wallet'

import { cctpRouteAsset } from 'entities/cctp'

import { type TradeWidgetParams } from 'modules/trade'

import { useCctpTransfer } from './useCctpTransfer'

export function useCctpSwapRoute({
  enabled,
  input,
  output,
  amount,
  recipient,
  recipientAddress,
  orderKind,
}: {
  enabled: boolean
  input: Currency | null | undefined
  output: Currency | null | undefined
  amount: CurrencyAmount<Currency> | null | undefined
  recipient: string | null | undefined
  recipientAddress: string | null | undefined
  orderKind: OrderKind
}): {
  params: Partial<TradeWidgetParams>
  active: boolean
  asset: ReturnType<typeof cctpRouteAsset>
  flow: ReturnType<typeof useCctpTransfer>
  output: CurrencyAmount<Currency> | null
  blocked: string | null
} {
  const { account } = useWalletInfo()
  const smartWallet = useIsSmartContractWallet()
  const bridgingEnabled = useIsBridgingEnabled()
  const asset = enabled && bridgingEnabled ? cctpRouteAsset(input, output) : undefined
  const key = JSON.stringify([
    enabled,
    input?.chainId,
    output?.chainId,
    asset,
    amount?.quotient.toString(),
    account,
    smartWallet,
    recipient,
    recipientAddress,
    orderKind,
  ])
  const flow = useCctpTransfer(key)
  const blocked = cctpBlockedReason(smartWallet, recipient, recipientAddress, account)
  const active = !!asset && !blocked
  const validQuote = active && orderKind === OrderKind.SELL ? flow.quote : null
  return {
    params: active
      ? {
          disableQuotePolling: true,
          disableTradeNotifications: true,
          isPriceStatic: true,
          disablePriceImpact: true,
          hideTradeWarnings: true,
          isTradePriceUpdating: !!flow.busy,
          inputsDisabled: !!flow.busy,
        }
      : {},
    active,
    asset,
    flow: { ...flow, quote: validQuote },
    blocked,
    output: cctpOutputAmount(validQuote, output),
  }
}

function cctpOutputAmount(
  quote: ReturnType<typeof useCctpTransfer>['quote'],
  output: Currency | null | undefined,
): CurrencyAmount<Currency> | null {
  if (!quote || !output) return null
  return CurrencyAmount.fromRawAmount(output, (BigInt(quote.amount) - BigInt(quote.maxFee)).toString())
}

function cctpBlockedReason(
  smartWallet: boolean | undefined,
  recipient: string | null | undefined,
  recipientAddress: string | null | undefined,
  account: string | undefined,
): string | null {
  if (smartWallet) return 'CCTP currently supports personal wallets. Connect a personal wallet to bridge.'
  if (recipient && !areAddressesEqual(recipientAddress || recipient, account))
    return 'CCTP delivers to your connected wallet. Clear the custom recipient to continue.'
  return null
}
