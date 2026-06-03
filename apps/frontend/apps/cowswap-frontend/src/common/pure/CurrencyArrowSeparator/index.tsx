import { ReactNode } from 'react'

import { isInjectedWidget } from '@cowprotocol/common-utils'

import { OphieMark } from 'ophis/components'

import * as styledEl from './styled'

export interface CurrencyArrowSeparatorProps {
  isLoading: boolean
  disabled?: boolean
  hasSeparatorLine?: boolean
  isCollapsed?: boolean
  isDarkMode?: boolean
  onSwitchTokens(): void
}

export function CurrencyArrowSeparator({
  isLoading,
  onSwitchTokens,
  isCollapsed = true,
  hasSeparatorLine,
  disabled = false,
}: CurrencyArrowSeparatorProps): ReactNode {
  const isInjectedWidgetMode = isInjectedWidget()

  return (
    <styledEl.Box
      id="currency-arrow-separator"
      data-isLoading={isLoading ? true : undefined}
      isCollapsed={isCollapsed}
      hasSeparatorLine={hasSeparatorLine}
    >
      <styledEl.LoadingWrapper
        type="button"
        aria-label="Switch tokens"
        $isLoading={isLoading}
        disabled={disabled}
        onClick={onSwitchTokens}
      >
        {!isInjectedWidgetMode && isLoading ? (
          <OphieMark size={26} fill="saffron" animate="spin-fast" ariaLabel="Switch tokens" />
        ) : (
          <styledEl.ArrowDownIcon disabled={disabled} />
        )}
      </styledEl.LoadingWrapper>
    </styledEl.Box>
  )
}
