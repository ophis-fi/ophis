import { useCallback, useEffect } from 'react'

import { LpToken, TokenWithLogo } from '@cowprotocol/common-const'
import { useIsBridgingEnabled } from '@cowprotocol/common-hooks'
import { Currency } from '@cowprotocol/currency'
import { getCurrencyTokenPolicyDecision, TokenPolicyProfile } from '@cowprotocol/tokens'

import { Nullish } from 'types'

import { Field } from 'legacy/state/types'

import { TradeType, useTradeTypeInfo } from 'modules/trade'
import { useTradeTypeInfoFromUrl } from 'modules/trade/hooks/useTradeTypeInfoFromUrl'

import { useCloseTokenSelectWidget } from './useCloseTokenSelectWidget'
import { useSelectTokenWidgetState } from './useSelectTokenWidgetState'
import { useUpdateSelectTokenWidgetState } from './useUpdateSelectTokenWidgetState'

import { TokenPickerOptions } from '../state/selectTokenWidgetAtom'

export function useOpenTokenSelectWidget(
  inputTokenOptions?: TokenPickerOptions,
  outputTokenOptions?: TokenPickerOptions,
): (
  selectedToken: Nullish<Currency>,
  field: Field | undefined,
  oppositeToken: TokenWithLogo | LpToken | Currency | undefined,
  onSelectToken: (currency: Currency) => void,
  targetChainId?: number,
) => void {
  const widget = useSelectTokenWidgetState()
  const activeOptions = widget.field === Field.OUTPUT ? outputTokenOptions : inputTokenOptions
  const updateSelectTokenWidget = useUpdateSelectTokenWidgetState()
  const closeTokenSelectWidget = useCloseTokenSelectWidget()
  const isBridgingEnabled = useIsBridgingEnabled()
  const tradeTypeInfoFromState = useTradeTypeInfo()
  const tradeTypeInfoFromUrl = useTradeTypeInfoFromUrl()
  const tradeTypeInfo = tradeTypeInfoFromState ?? tradeTypeInfoFromUrl
  const tradeType = tradeTypeInfo?.tradeType
  // Advanced trades lock the target chain so price guarantees stay valid while the widget is open.
  const shouldLockTargetChain = tradeType === TradeType.LIMIT_ORDER || tradeType === TradeType.ADVANCED_ORDERS

  useEffect(() => {
    if (widget.open && widget.tokenOptions !== activeOptions) {
      updateSelectTokenWidget({ tokenOptions: activeOptions })
    }
  }, [widget.open, widget.tokenOptions, activeOptions, updateSelectTokenWidget])

  return useCallback(
    (selectedToken, field, oppositeToken, onSelectToken, targetChainId) => {
      const tokenOptions = field === Field.OUTPUT ? outputTokenOptions : inputTokenOptions
      const isOutputField = field === Field.OUTPUT
      const nextSelectedTargetChainId =
        (isOutputField || !!tokenOptions) && selectedToken && isBridgingEnabled && !shouldLockTargetChain
          ? selectedToken.chainId
          : undefined

      updateSelectTokenWidget({
        selectedToken,
        tokenOptions,
        field,
        oppositeToken,
        open: true,
        forceOpen: false,
        selectedTargetChainId: shouldLockTargetChain
          ? nextSelectedTargetChainId
          : (targetChainId ?? nextSelectedTargetChainId),
        tradeType,
        onSelectToken: (currency) => {
          if (!getCurrencyTokenPolicyDecision(currency, TokenPolicyProfile.ESTABLISHED_SETTLEMENT).allowed) return

          // Keep selector UX consistent with #6251: always close after a selection, even if a chain switch follows.
          closeTokenSelectWidget({ overrideForceLock: true })
          onSelectToken(currency)
        },
      })
    },
    [
      closeTokenSelectWidget,
      updateSelectTokenWidget,
      isBridgingEnabled,
      shouldLockTargetChain,
      tradeType,
      inputTokenOptions,
      outputTokenOptions,
    ],
  )
}
