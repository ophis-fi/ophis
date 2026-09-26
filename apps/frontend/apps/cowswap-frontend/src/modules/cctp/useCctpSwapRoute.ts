import { useIsBridgingEnabled } from '@cowprotocol/common-hooks'
import { areAddressesEqual, OrderKind } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { AccountType } from '@cowprotocol/types'
import { useAccountType, useIsSmartContractWallet, useWalletInfo } from '@cowprotocol/wallet'

import { cctpRouteAsset, isBtcCctpSwap } from 'entities/cctp'

import { type TradeWidgetParams } from 'modules/trade'

import { type BtcSwapPending } from './btcSwapState'
import { type CctpQuote } from './cctp.service'
import { useBtcCctpSwap } from './useBtcCctpSwap'
import { useCctpTransfer } from './useCctpTransfer'

interface CctpSelection {
  enabled: boolean
  input: Currency | null | undefined
  output: Currency | null | undefined
  amount: CurrencyAmount<Currency> | null | undefined
  recipient: string | null | undefined
  recipientAddress: string | null | undefined
  orderKind: OrderKind
}

export function useCctpSwapRoute(selection: CctpSelection): {
  params: Partial<TradeWidgetParams>
  active: boolean
  asset: ReturnType<typeof cctpRouteAsset>
  flow: ReturnType<typeof useCctpTransfer>
  output: CurrencyAmount<Currency> | null
  blocked: string | null
  conversion: boolean
  btc: ReturnType<typeof useBtcCctpSwap>
} {
  const { enabled, input, output, amount, recipient, recipientAddress, orderKind } = selection
  const { account } = useWalletInfo()
  const smartWallet = useIsSmartContractWallet()
  const accountType = useAccountType()
  const bridgingEnabled = useIsBridgingEnabled()
  const { conversion, asset } = cctpSelectionAsset(
    enabled && bridgingEnabled && orderKind === OrderKind.SELL,
    input,
    output,
  )
  const key = cctpSelectionKey(selection, [account, smartWallet, accountType, asset])
  const flow = useCctpTransfer(key)
  const swapAmount = conversion ? amount : undefined
  const btc = useBtcCctpSwap(flow, key, swapAmount?.toExact(), swapAmount?.quotient.toString())
  const blocked = cctpBlockedReason(smartWallet, accountType, recipient, recipientAddress, account)
  const active = !!asset && !blocked
  const validQuote = cctpVisibleQuote(flow.quote, btc.pending, account, active)
  return {
    params: cctpWidgetParams(active, flow.busy),
    active,
    conversion,
    btc,
    asset,
    flow: { ...flow, quote: validQuote },
    blocked,
    output: cctpOutputAmount(validQuote || btc.quote?.bridge, input, output, active),
  }
}

function cctpOutputAmount(
  quote: CctpQuote | null | undefined,
  input: Currency | null | undefined,
  output: Currency | null | undefined,
  active: boolean,
): CurrencyAmount<Currency> | null {
  const { asset } = cctpSelectionAsset(active, input, output)
  if (
    !quote ||
    !input ||
    !output ||
    asset !== (quote.asset ?? 'USDC') ||
    quote.source !== input.chainId ||
    quote.destination !== output.chainId
  )
    return null
  return CurrencyAmount.fromRawAmount(output, (BigInt(quote.amount) - BigInt(quote.maxFee)).toString())
}

function cctpBlockedReason(
  smartWallet: boolean | undefined,
  accountType: AccountType | undefined,
  recipient: string | null | undefined,
  recipientAddress: string | null | undefined,
  account: string | undefined,
): string | null {
  if (account && accountType === undefined) return 'Wallet type is not confirmed. Reconnect your wallet to use CCTP.'
  if (smartWallet || (account && accountType !== AccountType.EOA))
    return 'CCTP currently supports personal wallets without smart-account code. Use another bridge route for this wallet.'
  if (recipient && !areAddressesEqual(recipientAddress || recipient, account))
    return 'CCTP delivers to your connected wallet. Clear the custom recipient to continue.'
  return null
}

function cctpSelectionKey(selection: CctpSelection, wallet: unknown[]): string {
  const { enabled, input, output, amount, recipient, recipientAddress, orderKind } = selection
  return JSON.stringify([
    enabled,
    input?.chainId,
    output?.chainId,
    input?.wrapped.address,
    output?.wrapped.address,
    amount?.quotient.toString(),
    recipient,
    recipientAddress,
    orderKind,
    ...wallet,
  ])
}

function cctpVisibleQuote(
  quote: CctpQuote | null,
  pending: BtcSwapPending | null,
  account: string | undefined,
  active: boolean,
): CctpQuote | null {
  if (!quote?.swapOrderUid) return active ? quote : null
  if (!pending) return null
  const recoveryMatches = [
    quote.swapOrderUid === pending.orderUid,
    quote.source === 1,
    quote.destination === 5042,
    quote.asset === 'cirBTC',
    areAddressesEqual(quote.owner, pending.owner),
    areAddressesEqual(quote.owner, account),
  ].every(Boolean)
  return recoveryMatches ? quote : null
}

function cctpWidgetParams(active: boolean, busy: string): Partial<TradeWidgetParams> {
  return active
    ? {
        disableQuotePolling: true,
        disableTradeNotifications: true,
        isPriceStatic: true,
        disablePriceImpact: true,
        hideTradeWarnings: true,
        isTradePriceUpdating: !!busy,
        inputsDisabled: !!busy,
        disableTokenSwitch: true,
      }
    : {}
}

function cctpSelectionAsset(
  enabled: boolean,
  input: CctpSelection['input'],
  output: CctpSelection['output'],
): {
  conversion: boolean
  asset: ReturnType<typeof cctpRouteAsset>
} {
  const conversion = enabled && isBtcCctpSwap(input, output)
  return {
    conversion,
    asset: enabled ? (cctpRouteAsset(input, output) ?? (conversion ? 'cirBTC' : undefined)) : undefined,
  }
}
