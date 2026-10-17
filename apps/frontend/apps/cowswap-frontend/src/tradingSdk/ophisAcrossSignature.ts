import { getRpcProvider } from '@cowprotocol/common-const'
import { areAddressesEqual, SupportedChainId } from '@cowprotocol/cow-sdk'
import { CowShedHooks } from '@cowprotocol/sdk-cow-shed'

import { utils } from 'ethers'

import { ERC1271, GuardedHookTerms, SHED_CALLS } from './ophisAcrossConstants'

/**
 * Whether the hook the SDK signed passes the shed's own check: signed by the
 * order owner (ECDSA, or EIP-1271 for a contract wallet) over exactly these
 * calls, nonce and deadline, for the owner's shed.
 */
export async function signedByOwner(
  chainId: SupportedChainId,
  terms: GuardedHookTerms,
  calls: Parameters<CowShedHooks['infoToSign']>[0],
  nonce: string,
  deadline: bigint,
  callData: string,
): Promise<boolean> {
  const decoded = (() => {
    try {
      return SHED_CALLS.decodeFunctionData('executeHooks', callData)
    } catch {
      return undefined // not a shed hook at all
    }
  })()
  if (!decoded || !areAddressesEqual(decoded.user, terms.owner)) return false
  const { signature } = decoded
  const { domain, types, message } = new CowShedHooks(chainId).infoToSign(calls, nonce, deadline, terms.shed)
  const digest = utils._TypedDataEncoder.hash(domain, types, message)
  const provider = getRpcProvider(chainId)
  if ((await provider.getCode(terms.owner)) === '0x')
    return areAddressesEqual(utils.recoverAddress(digest, signature), terms.owner)
  const answer = await provider.call({
    to: terms.owner,
    data: ERC1271.encodeFunctionData('isValidSignature', [digest, signature]),
  })
  return answer.slice(0, 10).toLowerCase() === '0x1626ba7e'
}
