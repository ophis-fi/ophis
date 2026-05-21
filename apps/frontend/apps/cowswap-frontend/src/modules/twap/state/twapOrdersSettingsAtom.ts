import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

import { getJotaiIsolatedStorage } from '@cowprotocol/core'
import { Percent } from '@cowprotocol/currency'

import { Milliseconds } from 'types'

import { DEFAULT_NUM_OF_PARTS, DEFAULT_ORDER_DEADLINE, DEFAULT_TWAP_SLIPPAGE } from '../const'

export interface TwapOrdersDeadline {
  readonly isCustomDeadline: boolean
  readonly deadline: Milliseconds
  readonly customDeadline: {
    hours: number
    minutes: number
  }
}

export interface TwapOrdersSettingsState extends TwapOrdersDeadline {
  readonly numberOfPartsValue: number
  readonly slippageValue: number | null
  readonly isFallbackHandlerSetupAccepted: boolean
}

export const defaultCustomDeadline: TwapOrdersDeadline['customDeadline'] = {
  hours: 0,
  minutes: 0,
}

export const defaultTwapOrdersSettings: TwapOrdersSettingsState = {
  // deadline
  isCustomDeadline: false,
  deadline: DEFAULT_ORDER_DEADLINE.value,
  customDeadline: defaultCustomDeadline,
  numberOfPartsValue: DEFAULT_NUM_OF_PARTS,
  // null = auto
  slippageValue: null,
  isFallbackHandlerSetupAccepted: false,
}

export const twapOrdersSettingsAtom = atomWithStorage<TwapOrdersSettingsState>(
  'twap-orders-settings-atom:v1',
  defaultTwapOrdersSettings,
  getJotaiIsolatedStorage(),
)

export const updateTwapOrdersSettingsAtom = atom(null, (get, set, nextState: Partial<TwapOrdersSettingsState>) => {
  set(twapOrdersSettingsAtom, () => {
    const prevState = get(twapOrdersSettingsAtom)

    return { ...prevState, ...nextState }
  })
})

export const twapOrderSlippageAtom = atom<Percent>((get) => {
  const { slippageValue } = get(twapOrdersSettingsAtom)

  // Persisted-state trust boundary (audit 2026-05-21). TypeScript
  // says `slippageValue: number | null`, but the hydrated runtime
  // value comes from localStorage — a malicious browser extension
  // or shared-machine tamperer can write a string/boolean/NaN.
  // `!= null` lets all of those through. `Math.round("abc" * 100)`
  // → NaN; `new Percent(NaN, 10000)` constructs a Percent whose
  // numerator is NaN; `percentToBps` then poisons the EIP-712
  // AppData hash the user signs. Defense: require a finite
  // non-negative number with a sane upper bound (≤50% — anything
  // higher is misconfiguration).
  if (
    typeof slippageValue === 'number' &&
    Number.isFinite(slippageValue) &&
    slippageValue >= 0 &&
    slippageValue <= 50
  ) {
    // Multiplying on 100 to allow decimals values (e.g 0.05)
    return new Percent(Math.round(slippageValue * 100), 10000)
  }
  return DEFAULT_TWAP_SLIPPAGE
})
