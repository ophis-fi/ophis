import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { withTimeout } from '@cowprotocol/common-utils'
import { useWalletProvider } from '@cowprotocol/wallet-provider'

import { atomWithQuery, type AtomWithQueryResult } from 'jotai-tanstack-query'

import {
  getOtcProviderForkId,
  getOtcWalletForkId,
  toOtcForkClients,
  toOtcLegacyForkClients,
  verifyOtcLocalForkProvider,
  verifyOtcLocalForkWallet,
} from './otcWriteAdapters'
import { readOtcAllowance } from './readOtcAllowance'

import type { OtcWalletSubmitter, OtcWriteClient } from './otcWrite.types'
import type { Address, Hex } from 'viem'

const ALLOWANCE_REFRESH_INTERVAL_MS = 5_000
const ALLOWANCE_READ_TIMEOUT_MS = 30_000
const LOCAL_FORK_VERIFICATION_ATTEMPTS = 10
const LOCAL_FORK_VERIFICATION_RETRY_MS = 750
const LOCAL_FORK_VERIFICATION_TIMEOUT_MS = 10_000
const OPHIS_ESCROW_KEY = 'swapboard-v1-mainnet'
const WALLET_TRANSPORT_IDS = new WeakMap<object, number>()
let nextWalletTransportId = 1

type AllowanceRead = Awaited<ReturnType<typeof readOtcAllowance>>
type WalletClientResult = Parameters<typeof toOtcForkClients>[0] | undefined

export interface OtcNetworkReads {
  transportId: number
  localForkResponse: OtcQueryResponse<Hex | null>
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
    mutate: async () => {
      const refreshed = await result.refetch()
      if (refreshed.error) throw refreshed.error
      return refreshed.data
    },
  }
}

export function withOtcForkVerificationTimeout<T>(verification: Promise<T>): Promise<T> {
  return withTimeout(verification, LOCAL_FORK_VERIFICATION_TIMEOUT_MS, 'Ophis OTC local fork verification timed out')
}

export function withOtcAllowanceReadTimeout(read: Promise<AllowanceRead>): Promise<AllowanceRead> {
  return withTimeout(read, ALLOWANCE_READ_TIMEOUT_MS, 'Ophis OTC allowance read timed out')
}

export async function retryOtcForkVerification(verify: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 1; attempt <= LOCAL_FORK_VERIFICATION_ATTEMPTS; attempt += 1) {
    if (await verify()) return true
    if (attempt < LOCAL_FORK_VERIFICATION_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, LOCAL_FORK_VERIFICATION_RETRY_MS))
    }
  }
  return false
}

export function useOtcNetworkReads(
  enabled: boolean,
  account: Address | undefined,
  chainId: number,
  walletClient: WalletClientResult,
  allowanceToken: Address | null,
): OtcNetworkReads {
  const legacyProvider = useWalletProvider()
  const walletSource = walletClient ?? legacyProvider
  const transportId = getOtcWalletTransportId(walletSource)
  const localForkQueryAtom = useMemo(
    () =>
      atomWithQuery<Hex | null, Error>(() => ({
        queryKey: [
          'ophis-otc-local-fork',
          account,
          chainId,
          walletClient ? 'wallet-client' : 'legacy-provider',
          transportId,
        ],
        queryFn: async () => {
          const verification = retryOtcForkVerification(() =>
            walletClient
              ? verifyOtcLocalForkWallet(walletClient)
              : legacyProvider
                ? verifyOtcLocalForkProvider(legacyProvider)
                : Promise.resolve(false),
          )
          return withOtcForkVerificationTimeout(
            verification.then((verified) => {
              if (!verified) return null
              if (walletClient) return getOtcWalletForkId(walletClient)
              if (legacyProvider) return getOtcProviderForkId(legacyProvider)
              return null
            }),
          )
        },
        enabled: !!enabled && !!account && !!walletSource,
        refetchOnWindowFocus: false,
        refetchInterval: ALLOWANCE_REFRESH_INTERVAL_MS,
      })),
    [account, chainId, enabled, legacyProvider, transportId, walletClient, walletSource],
  )
  const localForkQuery = useAtomValue(localForkQueryAtom)
  const forkId = localForkQuery.data ?? undefined
  const clients = useMemo(() => {
    if (walletClient) return toOtcForkClients(walletClient, forkId)
    if (legacyProvider && account) return toOtcLegacyForkClients(legacyProvider, account, forkId)
    return null
  }, [account, forkId, legacyProvider, walletClient])
  const writeClient = clients?.writeClient ?? null
  const wallet = clients?.wallet ?? null
  const allowanceQueryAtom = useMemo(
    () =>
      atomWithQuery<AllowanceRead | null, Error>(() => ({
        queryKey: ['ophis-otc-allowance', account, allowanceToken, OPHIS_ESCROW_KEY, chainId, transportId, forkId],
        queryFn: async () => {
          if (!account || !allowanceToken || !writeClient) return null
          return withOtcAllowanceReadTimeout(readOtcAllowance(writeClient, allowanceToken, account))
        },
        enabled: !!enabled && chainId === 1 && !!account && !!allowanceToken && !!writeClient,
        refetchInterval: ALLOWANCE_REFRESH_INTERVAL_MS,
        refetchOnWindowFocus: false,
      })),
    [account, allowanceToken, chainId, enabled, forkId, transportId, writeClient],
  )
  const allowanceQuery = useAtomValue(allowanceQueryAtom)
  const localForkResponse = useMemo(() => toOtcQueryResponse(localForkQuery), [localForkQuery])
  const allowanceResponse = useMemo(() => toOtcQueryResponse(allowanceQuery), [allowanceQuery])
  return useMemo(
    () => ({ transportId, localForkResponse, writeClient, wallet, allowanceResponse }),
    [allowanceResponse, localForkResponse, transportId, wallet, writeClient],
  )
}
