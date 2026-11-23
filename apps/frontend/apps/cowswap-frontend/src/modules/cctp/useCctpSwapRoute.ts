import { useIsBridgingEnabled } from '@cowprotocol/common-hooks'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { AccountType } from '@cowprotocol/types'
import { useAccountType, useIsSmartContractWallet, useWalletInfo } from '@cowprotocol/wallet'

import { type cctpRouteAsset } from 'entities/cctp'

import { type TradeWidgetParams } from 'modules/trade'

import { type BtcSwapPending } from './btcSwapState'
import { type CctpQuote } from './cctp.service'
import { type CctpSelection, useBridgeSelection } from './useBridgeSelection'
import { useBtcCctpSwap } from './useBtcCctpSwap'
import { useCctpTransfer } from './useCctpTransfer'

export function useCctpSwapRoute(selection: CctpSelection): {
  params: Partial<TradeWidgetParams>
  active: boolean
  arcPair: boolean
  outbound?: ReturnType<typeof useBridgeSelection>['outbound']
  asset: ReturnType<typeof cctpRouteAsset>
  flow: ReturnType<typeof useCctpTransfer>
  output: CurrencyAmount<Currency> | null
  blocked: string | null
  conversion: boolean
  btc: ReturnType<typeof useBtcCctpSwap>
} {
  const { enabled, input, output, amount, recipient, recipientAddress } = selection
  const { account } = useWalletInfo()
  const smartWallet = useIsSmartContractWallet()
  const accountType = useAccountType()
  const bridgingEnabled = useIsBridgingEnabled()
  const enabledHere = enabled && bridgingEnabled
  const blocked = cctpBlockedReason(smartWallet, accountType, recipient, recipientAddress, account)
  const { arcPair, asset, conversion, key, outbound, circle } = useBridgeSelection(selection, enabledHere, blocked, [
    account,
    smartWallet,
    accountType,
  ])
  const flow = useCctpTransfer(key)
  const swapAmount = conversion ? amount : undefined
  const btc = useBtcCctpSwap(flow, key, swapAmount?.toExact(), swapAmount?.quotient.toString())
  const active = (!!asset || !!outbound) && !blocked
  const validQuote = cctpVisibleQuote(flow.quote, btc.pending, account, active)
  return {
    params: cctpWidgetParams(active, flow.busy),
    active,
    conversion,
    arcPair,
    outbound,
    btc,
    asset,
    flow: { ...flow, quote: validQuote },
    blocked,
    output: cctpOutputAmount(validQuote || btc.quote?.bridge, input, output, asset, active && circle),
  }
}

function cctpOutputAmount(
  quote: CctpQuote | null | undefined,
  input: Currency | null | undefined,
  output: Currency | null | undefined,
  asset: ReturnType<typeof cctpRouteAsset>,
  visible: boolean,
): CurrencyAmount<Currency> | null {
  if (
    !visible ||
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
  if (account && accountType === undefined) return 'Wallet type is not confirmed. Reconnect your wallet to bridge.'
  if (smartWallet || (account && accountType !== AccountType.EOA))
    return 'This bridge requires a personal wallet without smart-account code.'
  if (recipient && !areAddressesEqual(recipientAddress || recipient, account))
    return 'This bridge delivers to your connected wallet. Clear the custom recipient to continue.'
  return null
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
