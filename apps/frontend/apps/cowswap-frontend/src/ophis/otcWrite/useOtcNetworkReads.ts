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
const WALLET_TRANSPORT_IDS = new WeakMap<object, number>()
let nextWalletTransportId = 1

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

export function getOtcWalletTransportId(source: object | undefined): number {
  if (!source) return 0
  const existing = WALLET_TRANSPORT_IDS.get(source)
  if (existing) return existing
  const assigned = nextWalletTransportId
  nextWalletTransportId += 1
  WALLET_TRANSPORT_IDS.set(source, assigned)
  return assigned
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
  const transportId = getOtcWalletTransportId(walletSource)
  const localForkQueryAtom = useMemo(
    () =>
      atomWithQuery<boolean, Error>(() => ({
        queryKey: [
          'ophis-otc-local-fork',
          account,
          chainId,
          walletClient ? 'wallet-client' : 'legacy-provider',
          transportId,
        ],
        queryFn: async () => {
          if (walletClient) return verifyOtcLocalForkWallet(walletClient)
          return legacyProvider ? verifyOtcLocalForkProvider(legacyProvider) : false
        },
        enabled: !!enabled && !!account && !!walletSource,
        refetchOnWindowFocus: false,
      })),
    [account, chainId, enabled, legacyProvider, transportId, walletClient, walletSource],
  )
  const localForkQuery = useAtomValue(localForkQueryAtom)
  const writeClient = clients?.writeClient ?? null
  const wallet = clients?.wallet ?? null
  const allowanceQueryAtom = useMemo(
    () =>
      atomWithQuery<AllowanceRead | null, Error>(() => ({
        queryKey: ['ophis-otc-allowance', account, allowanceToken, OPHIS_ESCROW_KEY, transportId],
        queryFn: async () => {
          if (!account || !allowanceToken || !writeClient) return null
          return readOtcAllowance(writeClient, allowanceToken, account)
        },
        enabled: !!enabled && localForkQuery.data === true && !!account && !!allowanceToken && !!writeClient,
        refetchInterval: ALLOWANCE_REFRESH_INTERVAL_MS,
        refetchOnWindowFocus: false,
      })),
    [account, allowanceToken, enabled, localForkQuery.data, transportId, writeClient],
  )
  const allowanceQuery = useAtomValue(allowanceQueryAtom)
  const localForkResponse = useMemo(() => toOtcQueryResponse(localForkQuery), [localForkQuery])
  const allowanceResponse = useMemo(() => toOtcQueryResponse(allowanceQuery), [allowanceQuery])
  return useMemo(
    () => ({ localForkResponse, writeClient, wallet, allowanceResponse }),
    [allowanceResponse, localForkResponse, wallet, writeClient],
  )
}
