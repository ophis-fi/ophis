import { RPC_URLS, SWR_NO_REFRESH_OPTIONS } from '@cowprotocol/common-const'
import { isAddress } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { JsonRpcProvider } from '@ethersproject/providers'

import useSWR from 'swr'

// Wallet identity lives on Ethereum, regardless of the selected trading chain.
const provider = new JsonRpcProvider(RPC_URLS[SupportedChainId.MAINNET], SupportedChainId.MAINNET)

export function useENSName(address?: string): { ENSName: string | null; loading: boolean } {
  const checkedAddress = address && isAddress(address)
  const { data, isLoading } = useSWR(
    checkedAddress ? ['useENSName', checkedAddress] : null,
    // Ethers verifies that the reverse name resolves forward to this address.
    ([, account]) => provider.lookupAddress(account),
    SWR_NO_REFRESH_OPTIONS,
  )

  return { ENSName: data ?? null, loading: isLoading }
}
