import { useMemo } from 'react'

import { LAUNCH_DARKLY_VIEM_MIGRATION } from '@cowprotocol/common-const'
import { useWalletProvider } from '@cowprotocol/wallet-provider'

import { createWalletClient, custom, type WalletClient } from 'viem'
import { useWalletClient } from 'wagmi'

export function useCctpWallet(): WalletClient | undefined {
  const { data: wallet } = useWalletClient()
  const legacy = useWalletProvider()
  return useMemo(
    () =>
      LAUNCH_DARKLY_VIEM_MIGRATION
        ? wallet
        : legacy
          ? createWalletClient({
              transport: custom(
                { request: ({ method, params }) => legacy.send(method, Array.isArray(params) ? params : []) },
                { retryCount: 0 },
              ),
            })
          : undefined,
    [wallet, legacy],
  )
}
