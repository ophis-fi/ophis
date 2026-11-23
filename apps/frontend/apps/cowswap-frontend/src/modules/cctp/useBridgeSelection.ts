import { useMemo, useState } from 'react'

import { OrderKind } from '@cowprotocol/cow-sdk'
import { type Currency, type CurrencyAmount } from '@cowprotocol/currency'

import { cctpRouteAsset, isArcOutboundPair, isBtcCctpSwap } from 'entities/cctp'

import { type ArcBridgeProvider } from './arcOutbound.service'

export interface CctpSelection {
  enabled: boolean
  input: Currency | null | undefined
  output: Currency | null | undefined
  amount: CurrencyAmount<Currency> | null | undefined
  recipient: string | null | undefined
  recipientAddress: string | null | undefined
  orderKind: OrderKind
}

export function useBridgeSelection(
  selection: CctpSelection,
  enabled: boolean,
  blocked: string | null,
  wallet: unknown[],
): {
  arcPair: boolean
  asset: ReturnType<typeof cctpRouteAsset>
  conversion: boolean
  key: string
  circle: boolean
  outbound:
    | { provider: ArcBridgeProvider | 'Circle'; choose(value: ArcBridgeProvider | 'Circle'): void; key: string }
    | undefined
} {
  const { input, output, orderKind } = selection
  const sell = orderKind === OrderKind.SELL
  const arcPair = enabled && isArcOutboundPair(input, output)
  const { asset, conversion } = cctpSelectionAsset(enabled && sell, input, output)
  const [preferred, choose] = useState<ArcBridgeProvider | 'Circle'>('Circle')
  const provider = preferred === 'Circle' && !asset ? 'Across' : preferred
  const key = cctpSelectionKey(selection, [...wallet, asset, provider])
  return useMemo(() => {
    const outbound = arcPair && sell && !blocked ? { provider, choose, key } : undefined
    return { arcPair, asset, conversion, key, outbound, circle: !outbound || provider === 'Circle' }
  }, [arcPair, asset, blocked, conversion, key, provider, sell])
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
