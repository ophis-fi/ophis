import { useEffect } from 'react'

import { useOphisNameResolution } from 'common/hooks/useOphisNameResolution'

import { useTradeState } from '../hooks/useTradeState'

// TODO: Add proper return type annotation
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function RecipientAddressUpdater() {
  const { state, updateState } = useTradeState()
  const recipientChainId = state?.targetChainId || state?.chainId || undefined
  const { address: recipientAddress } = useOphisNameResolution(state?.recipient, recipientChainId)

  useEffect(() => {
    if (state?.recipientAddress !== recipientAddress) {
      updateState?.({ ...state, recipientAddress })
    }
  }, [recipientAddress, state?.recipientAddress, updateState, state])

  return null
}
