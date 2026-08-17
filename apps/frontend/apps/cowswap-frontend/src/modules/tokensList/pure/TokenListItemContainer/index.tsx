import { ReactNode, useCallback } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { getAddressKey } from '@cowprotocol/cow-sdk'
import { getTokenPolicyDecision } from '@cowprotocol/tokens'

import { useSelectTokenWidgetState } from '../../hooks/useSelectTokenWidgetState'
import { SelectTokenContext } from '../../types'
import { TokenListItem } from '../TokenListItem'

interface TokenListItemContainerProps {
  token: TokenWithLogo
  context: SelectTokenContext
  disabled?: boolean
  disabledReason?: string
}

export function TokenListItemContainer({
  token,
  context,
  disabled,
  disabledReason,
}: TokenListItemContainerProps): ReactNode {
  const {
    unsupportedTokens,
    onTokenListItemClick,
    tokenListTags,
    permitCompatibleTokens,
    balancesState: { values: balances },
    isWalletConnected,
  } = context

  const { onSelectToken, selectedToken } = useSelectTokenWidgetState()

  const addressKey = getAddressKey(token.address)
  const tokenPolicyDecision = getTokenPolicyDecision({ chainId: token.chainId, address: token.address })
  const isDisabled = disabled || !tokenPolicyDecision.allowed
  const tokenPolicyDisabledReason = !tokenPolicyDecision.allowed
    ? 'Token has not passed the Ophis safety policy'
    : undefined
  const handleSelectToken = useCallback(
    (tokenToSelect: TokenWithLogo) => {
      onTokenListItemClick?.(tokenToSelect)
      onSelectToken?.(tokenToSelect)
    },
    [onSelectToken, onTokenListItemClick],
  )

  return (
    <TokenListItem
      isUnsupported={!!unsupportedTokens[addressKey]}
      isPermitCompatible={permitCompatibleTokens[addressKey]}
      selectedToken={selectedToken}
      token={token}
      balance={balances ? balances[addressKey] : undefined}
      onSelectToken={handleSelectToken}
      isWalletConnected={isWalletConnected}
      tokenListTags={tokenListTags}
      disabled={isDisabled}
      disabledReason={disabledReason || tokenPolicyDisabledReason}
    />
  )
}
