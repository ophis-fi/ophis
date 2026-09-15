import { useCallback } from 'react'

import { areAddressesEqual, SupportedChainId } from '@cowprotocol/cow-sdk'
import { parseOphisName, verifyOphisNameResolution } from '@cowprotocol/ens'

import { usePublicClient } from 'wagmi'

import { createOphisNameReader } from '../utils/createOphisNameReader'
import { isNonEvmRecipientChain, isRecipientAddress } from '../utils/recipientAddress.utils'

export type VerifyOphisRecipientName = (
  nameOrAddress: string | null | undefined,
  expectedAddress: string,
  recipientChainId: number,
) => Promise<void>

export function useVerifyOphisRecipientName(): VerifyOphisRecipientName {
  const client = usePublicClient({ chainId: SupportedChainId.MAINNET })

  return useCallback(
    async (nameOrAddress, expectedAddress, recipientChainId) => {
      if (nameOrAddress && isRecipientAddress(nameOrAddress, recipientChainId)) {
        if (!areAddressesEqual(nameOrAddress, expectedAddress))
          throw new Error('Recipient address changed before signing')
        return
      }
      if (isNonEvmRecipientChain(recipientChainId)) throw new Error('Invalid destination recipient address')
      if (!nameOrAddress) return
      if (recipientChainId !== SupportedChainId.MAINNET || !parseOphisName(nameOrAddress)) {
        throw new Error('Recipient name is not supported on this chain')
      }
      if (!client) throw new Error('Ethereum name resolution is unavailable')

      await verifyOphisNameResolution(createOphisNameReader(client), nameOrAddress, expectedAddress)
    },
    [client],
  )
}
