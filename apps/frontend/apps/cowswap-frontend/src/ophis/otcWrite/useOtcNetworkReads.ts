import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { useWalletProvider } from '@cowprotocol/wallet-provider'

import { atomWithQuery, type AtomWithQueryResult } from 'jotai-tanstack-query'

import {
  toOtcForkClients,
  toOtcLegacyForkClients,
  verifyOtcLocalForkProvider,
  verifyOtcLocalForkWallet,
} from './otcWriteAdapters'
import { readOtcAllowance } from './readOtcAllowance'

import type { OtcWalletSubmitter, OtcWriteClient } from './otcWrite.types'
import type { Address } from 'viem'

const ALLOWANCE_REFRESH_INTERVAL_MS = 5_000
const OPHIS_ESCROW_KEY = 'swapboard-v1-mainnet'

type AllowanceRead = Awaited<ReturnType<typeof readOtcAllowance>>
type WalletClientResult = Parameters<typeof toOtcForkClients>[0] | undefined

export interface OtcNetworkReads {
  localForkResponse: OtcQueryResponse<boolean>
  writeClient: OtcWriteClient | null
  wallet: OtcWalletSubmitter | null
  allowanceResponse: OtcQueryResponse<AllowanceRead | null>
}

interface OtcQueryResponse<T> {
  data: T | undefined
  error: Error | null
  mutate(): Promise<T | undefined>
}

function toOtcQueryResponse<T>(result: AtomWithQueryResult<T, Error>): OtcQueryResponse<T> {
  return {
    data: result.data,
    error: result.error,
    mutate: async () => (await result.refetch()).data,
  }
}

export function useOtcNetworkReads(
  enabled: boolean,
  account: Address | undefined,
  chainId: number,
  walletClient: WalletClientResult,
  allowanceToken: Address | null,
): OtcNetworkReads {
  const legacyProvider = useWalletProvider()
  const clients = useMemo(() => {
    if (walletClient) return toOtcForkClients(walletClient)
    if (legacyProvider && account) return toOtcLegacyForkClients(legacyProvider, account)
    return null
  }, [account, legacyProvider, walletClient])
  const walletSource = walletClient ?? legacyProvider
  const localForkQueryAtom = useMemo(
    () =>
      atomWithQuery<boolean, Error>(() => ({
        queryKey: ['ophis-otc-local-fork', account, chainId, walletClient ? 'wallet-client' : 'legacy-provider'],
        queryFn: async () => {
          if (walletClient) return verifyOtcLocalForkWallet(walletClient)
          return legacyProvider ? verifyOtcLocalForkProvider(legacyProvider) : false
        },
        enabled: !!enabled && !!account && !!walletSource,
        refetchOnWindowFocus: false,
      })),
    [account, chainId, enabled, legacyProvider, walletClient, walletSource],
  )
  const localForkQuery = useAtomValue(localForkQueryAtom)
  const writeClient = clients?.writeClient ?? null
  const wallet = clients?.wallet ?? null
  const allowanceQueryAtom = useMemo(
    () =>
      atomWithQuery<AllowanceRead | null, Error>(() => ({
        queryKey: ['ophis-otc-allowance', account, allowanceToken, OPHIS_ESCROW_KEY],
        queryFn: async () => {
          if (!account || !allowanceToken || !writeClient) return null
          return readOtcAllowance(writeClient, allowanceToken, account)
        },
        enabled: !!enabled && localForkQuery.data === true && !!account && !!allowanceToken && !!writeClient,
        refetchInterval: ALLOWANCE_REFRESH_INTERVAL_MS,
        refetchOnWindowFocus: false,
      })),
    [account, allowanceToken, enabled, localForkQuery.data, writeClient],
  )
  const allowanceQuery = useAtomValue(allowanceQueryAtom)
  const localForkResponse = useMemo(() => toOtcQueryResponse(localForkQuery), [localForkQuery])
  const allowanceResponse = useMemo(() => toOtcQueryResponse(allowanceQuery), [allowanceQuery])
  return useMemo(
    () => ({ localForkResponse, writeClient, wallet, allowanceResponse }),
    [allowanceResponse, localForkResponse, wallet, writeClient],
  )
}
