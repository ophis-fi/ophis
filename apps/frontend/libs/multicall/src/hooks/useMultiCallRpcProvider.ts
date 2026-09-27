import { useAtomValue } from 'jotai/index'
import { useMemo } from 'react'

import { getRpcProvider } from '@cowprotocol/common-const'
import { Nullish } from '@cowprotocol/types'
import { useIsBraveWallet, useIsWalletConnect } from '@cowprotocol/wallet'
import { useWalletChainId, useWalletProvider } from '@cowprotocol/wallet-provider'
import { JsonRpcProvider } from '@ethersproject/providers'

import { multiCallContextAtom } from '../state/multiCallContextAtom'

export function useMultiCallRpcProvider(): Nullish<JsonRpcProvider> {
  // TODO M-6 COW-573
  // This flow will be reviewed and updated later, to include a wagmi alternative
  const provider = useWalletProvider()
  const walletChainId = useWalletChainId()
  const context = useAtomValue(multiCallContextAtom)
  const isBraveWallet = useIsBraveWallet()
  const isWalletConnect = useIsWalletConnect()

  const contextChainId = context?.chainId

  return useMemo(() => {
    // We need to use our RPC node provider instead of wallet provider
    // when we need to make calls on other chains (e.g. balances)
    // if that is the case contextChainId is going to be defined and different from walletChainId
    // but just to be sure let's keep this existing comparison
    if (contextChainId && contextChainId !== walletChainId) {
      return getRpcProvider(contextChainId)
    }

    // Keep reads off Brave's RPC and WalletConnect's separate default-chain routing.
    // Signing still uses the connected wallet provider.
    if ((isBraveWallet || isWalletConnect) && walletChainId) {
      return getRpcProvider(walletChainId)
    }

    return provider
  }, [contextChainId, walletChainId, provider, isBraveWallet, isWalletConnect])
}
