import { useEffect } from 'react'

import { usePrevious } from '@cowprotocol/common-hooks'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useSetAtom } from 'jotai'

import { resetBasketAtom } from '../state/multiOrder.atoms'

/**
 * Clears the composed basket + in-flight draft whenever the connected account or
 * chain changes. A basket is composed for a specific account on a specific chain
 * (its legs, amounts and settlement chain apply only there), so a wallet or
 * network switch must not leave a stale basket that could be placed or cancelled
 * against the wrong context. Mirrors the GeoDataUpdater reset pattern
 * (usePrevious + areAddressesEqual for the account, plain compare for chainId).
 */
export function BasketResetUpdater(): null {
  const { account, chainId } = useWalletInfo()
  const prevAccount = usePrevious(account)
  const prevChainId = usePrevious(chainId)
  const resetBasket = useSetAtom(resetBasketAtom)

  useEffect(() => {
    const accountChanged = !areAddressesEqual(prevAccount, account)
    const chainChanged = prevChainId !== undefined && prevChainId !== chainId
    if (accountChanged || chainChanged) {
      resetBasket()
    }
  }, [account, prevAccount, chainId, prevChainId, resetBasket])

  return null
}
