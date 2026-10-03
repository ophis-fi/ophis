import { useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { useIsBridgingEnabled, useMachineTimeMs } from '@cowprotocol/common-hooks'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useWalletInfo } from '@cowprotocol/wallet'

import { getAddress, isAddress } from 'viem'

import { useBridgeWallet } from 'modules/cctp'
import { type TradeWidgetParams } from 'modules/trade'

import { getAcrossQuote, isArcAcrossRoute, type AcrossQuote, type AcrossRequest } from './acrossQuote.service'
import { acrossError, acrossPendingAtom, submitAcross } from './acrossState.service'
import { acrossNeedsApproval, approveAcross } from './acrossWallet.service'

interface AcrossSelection {
  enabled: boolean
  input: Currency | null | undefined
  output: Currency | null | undefined
  amount: CurrencyAmount<Currency> | null | undefined
  orderKind: OrderKind
  recipient: string | null | undefined
  recipientAddress: string | null | undefined
}
type Reviewed = { key: string; quote: AcrossQuote; needsApproval: boolean }
interface AcrossFlow extends ReturnType<typeof acrossActions> {
  active: boolean
  cctpEnabled: boolean
  params: Partial<TradeWidgetParams>
  quote: AcrossQuote | null
  output: CurrencyAmount<Currency> | null
  busy: string
  error: string
  needsApproval: boolean
  expired: boolean
  canQuote: boolean
}
function acrossRequest(selection: AcrossSelection, account: string | undefined, active: boolean): AcrossRequest | null {
  const recipient = selection.recipient ? selection.recipientAddress : account
  if (
    !active ||
    !account ||
    !isAddress(account) ||
    !recipient ||
    !isAddress(recipient) ||
    !selection.output ||
    !selection.amount?.greaterThan(0)
  )
    return null
  return {
    owner: getAddress(account),
    recipient: getAddress(recipient),
    destination: selection.output.chainId,
    amount: selection.amount.quotient.toString(),
  }
}

export function useAcrossDirect(selection: AcrossSelection): AcrossFlow {
  const { account } = useWalletInfo()
  const wallet = useBridgeWallet()
  const bridging = useIsBridgingEnabled()
  const active = [
    selection.enabled,
    bridging,
    selection.orderKind === OrderKind.SELL,
    isArcAcrossRoute(selection.input, selection.output),
  ].every(Boolean)
  const key = JSON.stringify(acrossRequest(selection, account, active))
  const request = useMemo(() => JSON.parse(key) as AcrossRequest | null, [key])
  const currentKey = useRef(key)
  useEffect(() => {
    currentKey.current = key
  }, [key])
  const [reviewed, setReviewed] = useState<Reviewed | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const persist = useSetAtom(acrossPendingAtom)
  const quote = reviewed?.key === key ? reviewed.quote : null
  const now = useMachineTimeMs(1000)
  const assertCurrent = useCallback((): void => {
    if (currentKey.current !== key) throw new Error('Swap details changed. Review a new quote.')
  }, [key])
  const run = useCallback(async (label: string, action: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(label)
    setError('')
    try {
      await action()
    } catch (failure) {
      setError(acrossError(failure))
    } finally {
      inFlight.current = false
      setBusy('')
    }
  }, [])
  return useMemo(
    () => ({
      active,
      quote,
      busy,
      error,
      cctpEnabled: selection.enabled && !active,
      params: acrossWidgetParams(active, busy),
      output: quote && selection.output ? CurrencyAmount.fromRawAmount(selection.output, quote.output) : null,
      needsApproval: reviewed?.needsApproval ?? true,
      expired: !!quote && now >= quote.expiresAt,
      canQuote: !!request,
      ...acrossActions({ wallet, quote, request, persist, assertCurrent, run, setReviewed, key }),
    }),
    [
      active,
      quote,
      busy,
      error,
      selection.enabled,
      selection.output,
      reviewed,
      now,
      request,
      run,
      assertCurrent,
      key,
      wallet,
      persist,
    ],
  )
}

interface ActionsContext {
  wallet: ReturnType<typeof useBridgeWallet>
  quote: AcrossQuote | null
  request: AcrossRequest | null
  persist: Parameters<typeof submitAcross>[2]
  assertCurrent: () => void
  run: (label: string, action: () => Promise<void>) => Promise<void>
  setReviewed: (value: Reviewed | null) => void
  key: string
}
function acrossActions(context: ActionsContext): {
  load(): Promise<void>
  approve(): Promise<void>
  send(): Promise<void>
  switchNetwork(): Promise<void>
} {
  const { wallet, quote, request, persist, assertCurrent, run, setReviewed, key } = context
  const refresh = async (request: AcrossRequest): Promise<void> => {
    const next = await getAcrossQuote(request)
    const needsApproval = await acrossNeedsApproval(next)
    assertCurrent()
    setReviewed({ key, quote: next, needsApproval })
  }
  return {
    load: () =>
      run('Getting Across quote…', async () => {
        if (!request) throw new Error('Enter an amount and a valid receiving address.')
        await refresh(request)
      }),
    approve: () =>
      run('Approve USDC in your wallet…', async () => {
        if (!wallet || !quote) throw new Error('Connect your wallet and review the bridge first.')
        await approveAcross(wallet, quote, assertCurrent)
        await refresh(quote)
      }),
    send: () =>
      run('Confirm the Across bridge in your wallet…', async () => {
        if (!wallet || !quote) throw new Error('Connect your wallet and review the bridge first.')
        await submitAcross(wallet, quote, persist, assertCurrent)
        setReviewed(null)
      }),
    switchNetwork: () =>
      run('Switch to Arc in your wallet…', async () => {
        if (!wallet) throw new Error('Connect your wallet first.')
        await wallet.switchChain({ id: ARC_CHAIN_ID })
      }),
  }
}
function acrossWidgetParams(active: boolean, busy: string): Partial<TradeWidgetParams> {
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
