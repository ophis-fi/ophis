import { useEffect } from 'react'

import { usePrevious } from '@cowprotocol/common-hooks'
import { Command } from '@cowprotocol/types'
import { useWalletInfo } from '@cowprotocol/wallet'

/**
 * Handles EthFlow chain change by calling onDismiss when it happens
 */
export function useHandleChainChange(onDismiss: Command): null {
  const { chainId, account } = useWalletInfo()
  const prevChainId = usePrevious(chainId)
  const prevAccount = usePrevious(account)

  useEffect(() => {
    if ((prevChainId && chainId !== prevChainId) || (prevAccount && account !== prevAccount)) onDismiss()
  }, [chainId, account, onDismiss, prevChainId, prevAccount])

  return null
}
