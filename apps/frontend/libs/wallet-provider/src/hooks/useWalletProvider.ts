import { useMemo } from 'react'

import type { Web3Provider } from '@ethersproject/providers'
import { useWeb3React } from '@web3-react/core'

import { OphisBaseProvider } from '../OphisBaseProvider'

export function useWalletProvider(): Web3Provider | undefined {
  const { provider, chainId } = useWeb3React()

  return useMemo(
    () => (chainId === 8453 && provider?.provider ? new OphisBaseProvider(provider) : provider),
    [provider, chainId],
  )
}
