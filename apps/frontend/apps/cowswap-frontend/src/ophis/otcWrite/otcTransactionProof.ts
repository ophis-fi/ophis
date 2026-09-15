import { withTimeout } from '@cowprotocol/common-utils'

import { OPHIS_ETHEREUM_OTC_MANIFEST } from 'ophis/otc'
import { encodeAbiParameters, keccak256 } from 'viem'

import type { OtcTransactionRequest } from './otcWrite.types'
import type { OtcSubmissionProof } from 'entities/otc'
import type { Hex, PublicClient } from 'viem'

export function assertOtcTransactionHash(hash: unknown): asserts hash is Hex {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error('Ophis OTC wallet returned an invalid transaction hash')
  }
}

export function otcRequestHash(request: Pick<OtcTransactionRequest, 'account' | 'to' | 'data' | 'value'>): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'bytes' }, { type: 'uint256' }],
      [request.account, request.to, request.data, request.value],
    ),
  )
}

export async function readOtcSubmissionProof(
  client: PublicClient | undefined,
  request: OtcTransactionRequest,
  readWalletNonce: () => Promise<number>,
): Promise<OtcSubmissionProof | undefined> {
  if (!client) return undefined
  const [nonce, walletNonce, code, confirmedNonce] = await withTimeout(
    Promise.all([
      client.getTransactionCount({ address: request.account, blockTag: 'pending' }),
      readWalletNonce(),
      client.getBytecode({ address: request.account, blockTag: 'pending' }),
      client.getTransactionCount({ address: request.account, blockTag: 'latest' }),
    ]),
    OPHIS_ETHEREUM_OTC_MANIFEST.readTimeoutMs,
    'Ophis OTC transaction nonce read timed out',
  )
  if (code !== undefined && code !== '0x') throw new Error('Ophis OTC contract wallets are not supported')
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Ophis OTC transaction nonce unavailable')
  if (!Number.isSafeInteger(confirmedNonce) || confirmedNonce <= 0 || confirmedNonce > nonce)
    throw new Error('Ophis OTC requires a prior confirmed Ethereum transaction')
  if (nonce !== walletNonce)
    throw new Error('Ophis OTC pending transaction nonce differs between wallet and canonical reader')
  return { requestHash: otcRequestHash(request), nonce }
}

/** Confirm the exact nonce sent to the signer, including identical gas repricings. */
export async function verifyOtcTransactionProof(
  client: PublicClient,
  hash: Hex,
  proof: OtcSubmissionProof,
): Promise<void> {
  const transaction = await withTimeout(
    client.getTransaction({ hash }),
    OPHIS_ETHEREUM_OTC_MANIFEST.readTimeoutMs,
    'Ophis OTC transaction verification timed out',
  )
  if (
    !transaction.to ||
    !Number.isSafeInteger(transaction.nonce) ||
    transaction.nonce !== proof.nonce ||
    transaction.hash.toLowerCase() !== hash.toLowerCase() ||
    transaction.value !== 0n
  ) {
    throw new Error('Ophis OTC confirmed transaction differs from reviewed intent')
  }
  const requestHash = otcRequestHash({
    account: transaction.from,
    to: transaction.to,
    data: transaction.input,
    value: 0n,
  })
  if (requestHash !== proof.requestHash) throw new Error('Ophis OTC confirmed transaction differs from reviewed intent')
}
