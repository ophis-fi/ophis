import { useMemo } from 'react'

import type { useWalletProvider } from '@cowprotocol/wallet-provider'

import { usePublicClient } from 'wagmi'

import { toOtcForkClients, toOtcLegacyForkClients } from './otcWriteAdapters'

import type { Address } from 'viem'

type WalletClientResult = Parameters<typeof toOtcForkClients>[0] | undefined

export function useOtcBaseClients(
  account: Address | undefined,
  walletClient: WalletClientResult,
  legacyProvider: ReturnType<typeof useWalletProvider>,
): { canaryClient: ReturnType<typeof usePublicClient>; baseClients: ReturnType<typeof toOtcForkClients> | null } {
  const publicClient = usePublicClient({ chainId: 1 })
  const canaryMode = process.env.REACT_APP_OTC_WRITE_MODE === 'canary'
  const canaryClient = canaryMode ? publicClient : undefined
  const baseClients = useMemo(() => {
    if (canaryMode && !canaryClient) return null
    if (walletClient) return toOtcForkClients(walletClient, undefined, canaryClient)
    if (legacyProvider && account) return toOtcLegacyForkClients(legacyProvider, account, undefined, canaryClient)
    return null
  }, [account, canaryClient, canaryMode, legacyProvider, walletClient])
  return useMemo(() => ({ canaryClient, baseClients }), [canaryClient, baseClients])
}
