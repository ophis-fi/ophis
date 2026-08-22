import { isLocal as runtimeIsLocal } from '@cowprotocol/common-utils'

import { OPHIS_ETHEREUM_OTC_MANIFEST, readOtcOrder, verifyOtcContract } from 'ophis/otc'
import { isAddressEqual } from 'viem'

import { buildOtcTransaction } from './buildOtcTransaction'

import type {
  OtcTransactionReceipt,
  OtcWalletSubmitter,
  OtcWriteClient,
  OtcWriteIntent,
  OtcWriteRuntimeAuthorization,
  PreparedOtcTransaction,
} from './otcWrite.types'
import type { OtcManifest, OtcOrder } from 'ophis/otc'

function sameOrder(expected: OtcOrder, current: OtcOrder): boolean {
  return (
    expected.orderId === current.orderId &&
    isAddressEqual(expected.maker, current.maker) &&
    expected.active === current.active &&
    isAddressEqual(expected.tokenA, current.tokenA) &&
    expected.amountA === current.amountA &&
    isAddressEqual(expected.tokenB, current.tokenB) &&
    expected.amountB === current.amountB
  )
}

function orderFromIntent(intent: OtcWriteIntent): OtcOrder | null {
  return intent.kind === 'approve-fill' || intent.kind === 'fill' || intent.kind === 'cancel' ? intent.order : null
}

function assertRuntimeAuthorization(authorization: OtcWriteRuntimeAuthorization): void {
  const runtimeWriteMode = process.env.REACT_APP_OTC_WRITE_MODE
  const enabled =
    authorization.readFlag === true &&
    authorization.writeFlag === true &&
    authorization.isLocal === runtimeIsLocal &&
    authorization.writeMode === runtimeWriteMode &&
    runtimeIsLocal &&
    runtimeWriteMode === 'fork'
  if (!enabled) throw new Error('Ophis OTC writes are disabled')
}

/**
 * Re-verifies the deployed source, re-reads order terms where applicable, and
 * simulates the exact calldata at that verified block. No wallet call occurs.
 */
export async function prepareOtcTransaction(
  client: OtcWriteClient,
  intent: OtcWriteIntent,
  nowSeconds: bigint,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
): Promise<PreparedOtcTransaction> {
  const expectedOrder = orderFromIntent(intent)
  let blockNumber: bigint

  if (expectedOrder) {
    const current = await readOtcOrder(client, expectedOrder.orderId, manifest)
    if (!current.order || !sameOrder(expectedOrder, current.order)) {
      throw new Error('Ophis OTC order changed before submission')
    }
    blockNumber = current.blockNumber
  } else {
    blockNumber = (await verifyOtcContract(client, manifest)).blockNumber
  }

  const request = buildOtcTransaction(intent, nowSeconds)
  await client.simulate(request, blockNumber)
  return { request, simulatedAtBlock: blockNumber }
}

/**
 * The only wallet-submission sink. Authorization is checked again immediately
 * before fresh preflight, exact simulation, submission, and receipt tracking.
 */
export async function submitOtcTransaction(
  client: OtcWriteClient,
  wallet: OtcWalletSubmitter,
  intent: OtcWriteIntent,
  authorization: OtcWriteRuntimeAuthorization,
  nowSeconds: bigint,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
): Promise<OtcTransactionReceipt> {
  assertRuntimeAuthorization(authorization)
  const prepared = await prepareOtcTransaction(client, intent, nowSeconds, manifest)
  const hash = await wallet.sendTransaction(prepared.request)
  const receipt = await wallet.waitForTransactionReceipt(hash)
  if (receipt.status !== 'success') throw new Error('Ophis OTC transaction reverted')
  return receipt
}
