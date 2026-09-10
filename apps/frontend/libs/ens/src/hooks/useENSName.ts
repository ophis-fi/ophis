import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { RPC_URLS } from '@cowprotocol/common-const'
import { isAddress } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { JsonRpcProvider } from '@ethersproject/providers'

import { atomWithQuery } from 'jotai-tanstack-query'

// Wallet identity lives on Ethereum, regardless of the selected trading chain.
const provider = new JsonRpcProvider(RPC_URLS[SupportedChainId.MAINNET], SupportedChainId.MAINNET)

export function useENSName(address?: string): { ENSName: string | null; loading: boolean } {
  const checkedAddress = (address && isAddress(address)) || null
  const queryAtom = useMemo(
    () =>
      atomWithQuery(() => ({
        queryKey: ['ethereum-ens-name', checkedAddress],
        enabled: !!checkedAddress,
        // Ethers verifies that the reverse name resolves forward to this address.
        queryFn: async () => (checkedAddress ? provider.lookupAddress(checkedAddress) : null),
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        retry: false,
      })),
    [checkedAddress],
  )
  const { data, isLoading } = useAtomValue(queryAtom)
  return useMemo(() => ({ ENSName: data ?? null, loading: isLoading }), [data, isLoading])
}
