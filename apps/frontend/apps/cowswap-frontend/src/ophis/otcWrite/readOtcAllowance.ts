import { assertTradeTokenPolicy, TokenPolicyProfile } from '@cowprotocol/tokens'

import { OPHIS_ETHEREUM_OTC_MANIFEST, verifyOtcContract } from 'ophis/otc'
import { decodeFunctionResult, encodeFunctionData, type Address } from 'viem'

import { OTC_ALLOWANCE_ABI } from './otcWrite.abi'

import type { OtcWriteClient } from './otcWrite.types'
import type { OtcManifest } from 'ophis/otc'

const ALLOWANCE_CALL_GAS = 60_000n
const UINT256_RETURN_BYTES = 32

export interface OtcAllowanceRead {
  allowance: bigint
  blockNumber: bigint
}

/**
 * Revalidates the pinned escrow source, then reads one reviewed token's
 * allowance at that exact block. This is the sole allowance authority for the
 * fork-only action controller; optimistic allowance state is never accepted.
 */
export async function readOtcAllowance(
  client: OtcWriteClient,
  token: Address,
  owner: Address,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
): Promise<OtcAllowanceRead> {
  assertTradeTokenPolicy(
    { chainId: manifest.chainId, address: token },
    { chainId: manifest.chainId, address: token },
    TokenPolicyProfile.OTC_ESCROW,
  )
  const verified = await verifyOtcContract(client, manifest)
  const response = await client.call({
    to: token,
    data: encodeFunctionData({
      abi: OTC_ALLOWANCE_ABI,
      functionName: 'allowance',
      args: [owner, manifest.contract.address],
    }),
    gas: ALLOWANCE_CALL_GAS,
    blockNumber: verified.blockNumber,
  })
  if (!response.data || (response.data.length - 2) / 2 !== UINT256_RETURN_BYTES) {
    throw new Error('Ophis OTC allowance read rejected')
  }
  return {
    allowance: decodeFunctionResult({ abi: OTC_ALLOWANCE_ABI, functionName: 'allowance', data: response.data }),
    blockNumber: verified.blockNumber,
  }
}
