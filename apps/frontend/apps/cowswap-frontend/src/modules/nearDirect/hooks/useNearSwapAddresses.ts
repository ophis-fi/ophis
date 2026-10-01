import { useOphisNameResolution } from 'common/hooks/useOphisNameResolution'
import { isNonEvmRecipientChain } from 'common/utils/recipientAddress.utils'

import { DIRECT_NEAR_CHAINS } from '../nearDirect.constants'
import { NearToken } from '../nearDirect.schemas'
import { isNearAddress } from '../nearDirect.service'

function useAddress(token: NearToken | undefined, value: string): string {
  const chainId = token && DIRECT_NEAR_CHAINS[token.blockchain]?.id
  const nonEvm = isNonEvmRecipientChain(chainId)
  const resolution = useOphisNameResolution(nonEvm ? null : value, chainId)
  if (!token || resolution.integrityError || resolution.loading) return ''
  const address = nonEvm ? value.trim() : resolution.address
  return address && isNearAddress(token.blockchain, address) ? address : ''
}

export function useNearSwapAddresses(
  source: NearToken | undefined,
  destination: NearToken | undefined,
  refundTo: string,
  recipient: string,
): { recipient: string; refundTo: string } {
  return { recipient: useAddress(destination, recipient), refundTo: useAddress(source, refundTo) }
}
