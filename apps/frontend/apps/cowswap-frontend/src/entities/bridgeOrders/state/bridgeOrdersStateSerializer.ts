import { TokenWithLogo } from '@cowprotocol/common-const'
import { getCurrencyAddress } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import type { PersistentStateByChainAccount, SerializedAmount, BridgeQuoteAmounts } from '@cowprotocol/types'

// Persisted-state trust boundary (Phase 4 audit DoS-class finding):
// `deserializeAmount` previously called `CurrencyAmount.fromRawAmount` and
// `TokenWithLogo.fromToken` directly on persisted-localStorage blobs. Both
// throw on malformed input (browser-extension corruption, schema drift):
//   - CurrencyAmount.fromRawAmount('not-a-bigint') → BigInt() throws
//   - TokenWithLogo.fromToken({ chainId: undefined }) → invariant throws
// One corrupt bridge order in storage = the entire app crashes at render.
//
// Fix: validate SerializedAmount shape upfront; on mismatch, the
// deserializer returns null and the mapping function (in bridgeOrdersAtom)
// drops the bad order from the in-memory state. A single deduplicated
// console.warn surfaces the upstream bug in DevTools / Sentry.
let _warned = false
function warnOnce(context: string, value: unknown): void {
  if (_warned) return
  _warned = true

  console.warn(`[bridgeOrdersStateSerializer] ${context}; dropping malformed entry`, { value })
}

function isValidSerializedToken(value: unknown): value is SerializedAmount['token'] {
  if (!value || typeof value !== 'object') return false
  const t = value as Partial<SerializedAmount['token']>
  return (
    typeof t.chainId === 'number' &&
    typeof t.address === 'string' &&
    t.address.length > 0 &&
    typeof t.decimals === 'number' &&
    Number.isInteger(t.decimals) &&
    t.decimals >= 0
  )
}

function isValidSerializedAmount(value: unknown): value is SerializedAmount {
  if (!value || typeof value !== 'object') return false
  const a = value as Partial<SerializedAmount>
  if (typeof a.amount !== 'string' || !/^[+-]?\d+$/.test(a.amount)) return false
  return isValidSerializedToken(a.token)
}

export function bridgeOrdersStateSerializer<T, Q, R extends PersistentStateByChainAccount<Q[]>>(
  state: PersistentStateByChainAccount<T[]>,
  mappingFunction: (item: T) => Q | null,
): R {
  if (!state || typeof state !== 'object') {
    warnOnce('top-level state is not an object', state)
    return {} as R
  }

  return Object.keys(state).reduce<Partial<R>>((acc, _chainId) => {
    const chainId = +_chainId as SupportedChainId
    const chainState = state[chainId]

    if (!chainState || typeof chainState !== 'object') return acc

    const deserializedChainState = Object.keys(chainState).reduce<Record<string, Q[]>>((acc2, account) => {
      const orders = chainState[account]

      if (!Array.isArray(orders) || orders.length === 0) return acc2

      // Filter out entries whose mappingFunction returned null. Each null
      // represents an unrecoverable shape mismatch already warned about.
      const mapped: Q[] = []
      for (const order of orders) {
        try {
          const result = mappingFunction(order)
          if (result !== null) mapped.push(result)
        } catch (e) {
          warnOnce(`mappingFunction threw: ${(e as Error)?.message}`, order)
        }
      }

      if (mapped.length > 0) acc2[account] = mapped

      return acc2
    }, {})

    acc[chainId] = deserializedChainState

    return acc
  }, {}) as R
}

function deserializeBridgeFeeAmounts(
  feeAmounts: BridgeQuoteAmounts<SerializedAmount>['bridgeFeeAmounts'],
): BridgeQuoteAmounts['bridgeFeeAmounts'] {
  if (!feeAmounts) return undefined
  const dest = deserializeAmount(feeAmounts.amountInDestinationCurrency)
  const interm = deserializeAmount(feeAmounts.amountInIntermediateCurrency)
  if (!dest || !interm) return undefined
  return { amountInDestinationCurrency: dest, amountInIntermediateCurrency: interm }
}

type DeserializedAmount = CurrencyAmount<Currency | TokenWithLogo>

const REQUIRED_AMOUNT_KEYS = [
  'swapSellAmount',
  'swapBuyAmount',
  'swapMinReceiveAmount',
  'bridgeMinReceiveAmount',
  'bridgeFee',
] as const
type RequiredAmountKey = (typeof REQUIRED_AMOUNT_KEYS)[number]

function deserializeRequiredAmounts(
  amounts: BridgeQuoteAmounts<SerializedAmount> | undefined,
): Record<RequiredAmountKey, DeserializedAmount> | null {
  const out: Partial<Record<RequiredAmountKey, DeserializedAmount>> = {}
  for (const key of REQUIRED_AMOUNT_KEYS) {
    const deserialized = deserializeAmount(amounts?.[key])
    if (!deserialized) return null
    out[key] = deserialized
  }
  return out as Record<RequiredAmountKey, DeserializedAmount>
}

export function deserializeQuoteAmounts(amounts: BridgeQuoteAmounts<SerializedAmount>): BridgeQuoteAmounts | null {
  // Required fields — if any is malformed, the whole quote is unusable
  // and the parent order must be dropped (we have no way to render an
  // order with partial amounts; signing already happened off-chain).
  const required = deserializeRequiredAmounts(amounts)
  if (!required) {
    warnOnce('one of the required amounts is malformed', amounts)
    return null
  }

  return {
    ...required,
    swapExpectedReceive: amounts.swapExpectedReceive ? deserializeAmount(amounts.swapExpectedReceive) : null,
    bridgeFeeAmounts: deserializeBridgeFeeAmounts(amounts.bridgeFeeAmounts),
  }
}

export function serializeQuoteAmounts(amounts: BridgeQuoteAmounts): BridgeQuoteAmounts<SerializedAmount> {
  return {
    swapSellAmount: serializeAmount(amounts.swapSellAmount),
    swapBuyAmount: serializeAmount(amounts.swapBuyAmount),
    swapExpectedReceive: amounts.swapExpectedReceive ? serializeAmount(amounts.swapExpectedReceive) : null,
    swapMinReceiveAmount: serializeAmount(amounts.swapMinReceiveAmount),
    bridgeMinReceiveAmount: serializeAmount(amounts.bridgeMinReceiveAmount),
    bridgeFee: serializeAmount(amounts.bridgeFee),
    bridgeFeeAmounts: amounts.bridgeFeeAmounts
      ? {
          amountInDestinationCurrency: serializeAmount(amounts.bridgeFeeAmounts.amountInDestinationCurrency),
          amountInIntermediateCurrency: serializeAmount(amounts.bridgeFeeAmounts.amountInIntermediateCurrency),
        }
      : undefined,
  }
}

function deserializeAmount(amount: unknown): CurrencyAmount<Currency | TokenWithLogo> | null {
  if (!isValidSerializedAmount(amount)) {
    warnOnce('SerializedAmount failed shape validation', amount)
    return null
  }
  try {
    const token = TokenWithLogo.fromToken(amount.token, amount.token.logoURI)
    return CurrencyAmount.fromRawAmount(token, amount.amount)
  } catch (e) {
    warnOnce(`amount construction threw: ${(e as Error)?.message}`, amount)
    return null
  }
}

function serializeAmount(amount: CurrencyAmount<Currency | TokenWithLogo>): SerializedAmount {
  return {
    amount: amount.quotient.toString(),
    token: {
      logoURI: (amount.currency as TokenWithLogo).logoURI,
      chainId: amount.currency.chainId,
      address: getCurrencyAddress(amount.currency),
      decimals: amount.currency.decimals,
      symbol: amount.currency.symbol || '',
      name: amount.currency.name || '',
    },
  }
}
