import { useMemo } from 'react'

import { useWalletProvider } from '@cowprotocol/wallet-provider'

import { createWalletClient, custom, type WalletClient } from 'viem'
import { useWalletClient } from 'wagmi'

export function useCctpWallet(): WalletClient | undefined {
  const { data: wallet } = useWalletClient()
  const legacy = useWalletProvider()
  return useMemo(
    () =>
      wallet ||
      (legacy
        ? createWalletClient({
            transport: custom(
              { request: ({ method, params }) => legacy.send(method, Array.isArray(params) ? params : []) },
              { retryCount: 0 },
            ),
          })
        : undefined),
    [wallet, legacy],
  )
}
