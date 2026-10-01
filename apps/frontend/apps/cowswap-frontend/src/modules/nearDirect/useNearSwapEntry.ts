import { useAtomValue } from 'jotai'
import { useMemo, useState } from 'react'

import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { isSupportedChainId } from '@cowprotocol/common-utils'
import { Currency } from '@cowprotocol/currency'

import { useIsOphisSwap } from 'ophis/hooks/useIsOphisSwap'

import { Field } from 'legacy/state/types'

import { TokenPickerOptions } from 'modules/tokensList'
import { useDerivedTradeState } from 'modules/trade'

import { nearTokensAtom } from './nearDirect.atoms'
import { nearTokenPickerOptions } from './nearSwapAssets.utils'

export interface NearSwapSelection {
  input: Currency
  output: Currency | null
  amount: string
}

export function useNearSwapEntry(): {
  selection: NearSwapSelection | null
  enabled: boolean
  tokenOptions: TokenPickerOptions | undefined
  enter(field: Field, currency: Currency | null): boolean
  exit(): void
} {
  const isOphis = useIsOphisSwap()
  const { isNearIntentsBridgeProviderEnabled } = useFeatureFlags()
  const enabled = isOphis && isNearIntentsBridgeProviderEnabled === true
  const { data: tokens = [] } = useAtomValue(nearTokensAtom)
  const [selection, setSelection] = useState<NearSwapSelection | null>(null)
  const state = useDerivedTradeState()
  const tokenOptions = useMemo(() => (enabled ? nearTokenPickerOptions(tokens, true) : undefined), [enabled, tokens])
  return {
    selection: enabled ? selection : null,
    enabled,
    tokenOptions,
    enter(field, currency) {
      if (!enabled || field !== Field.INPUT || !currency || isSupportedChainId(currency.chainId)) return false
      setSelection({
        input: currency,
        output: state?.outputCurrency ?? null,
        amount: state?.inputCurrencyAmount?.toExact() ?? '',
      })
      return true
    },
    exit: () => setSelection(null),
  }
}
