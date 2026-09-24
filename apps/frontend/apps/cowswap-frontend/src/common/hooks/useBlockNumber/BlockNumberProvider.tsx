import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { useIsWindowVisible } from '@cowprotocol/common-hooks'
import { useWalletInfo } from '@cowprotocol/wallet'
import { useWalletChainId, useWalletProvider } from '@cowprotocol/wallet-provider'

import { BlockNumberContext } from './context'

export function BlockNumberProvider({ children }: { children: ReactNode }): ReactNode {
  // TODO M-6 COW-573
  // This flow will be reviewed and updated later, to include a wagmi alternative
  const provider = useWalletProvider()
  const activeChainId = useWalletChainId()
  const { account } = useWalletInfo()

  const [{ chainId, block }, setChainBlock] = useState<{ chainId?: number; block?: number }>({ chainId: activeChainId })

  const onBlock = useCallback(
    (block: number) => {
      setChainBlock((chainBlock) => {
        if (chainBlock.chainId === activeChainId) {
          if (!chainBlock.block || chainBlock.block < block) {
            return { chainId: activeChainId, block }
          }
        }
        return chainBlock
      })
    },
    [activeChainId, setChainBlock],
  )

  const windowVisible = useIsWindowVisible()
  useEffect(() => {
    let stale = false

    if (provider && activeChainId && windowVisible) {
      // If chainId hasn't changed, don't clear the block. This prevents re-fetching still valid data.
      setChainBlock((chainBlock) => (chainBlock.chainId === activeChainId ? chainBlock : { chainId: activeChainId }))

      provider
        .getBlockNumber()
        .then((block) => {
          if (!stale) onBlock(block)
        })
        .catch((error) => {
          console.error(`Failed to get block number for chainId ${activeChainId}`, error)
        })

      // The read-only network connector is active even without a wallet.
      if (account) provider.on('block', onBlock)

      return () => {
        stale = true
        provider.removeListener('block', onBlock)
      }
    }

    return void 0
  }, [activeChainId, provider, onBlock, setChainBlock, windowVisible, account])

  const value = useMemo(
    () => ({
      value: chainId === activeChainId ? block : undefined,
    }),
    [activeChainId, block, chainId],
  )
  return <BlockNumberContext.Provider value={value}>{children}</BlockNumberContext.Provider>
}
