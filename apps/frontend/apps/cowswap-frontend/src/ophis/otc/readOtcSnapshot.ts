import { withTimeout } from '@cowprotocol/common-utils'

import { decodeFunctionResult, encodeFunctionData, isAddressEqual, keccak256, type Address, type Hex } from 'viem'

import { OTC_READ_ABI } from './otc.abi'
import { OPHIS_ETHEREUM_OTC_MANIFEST } from './otc.const'
import { parseOtcOrders } from './parseOtcOrders'

import type { OtcManifest, OtcOrder, OtcReadCall, OtcReaderClient, OtcSnapshot } from './otc.types'

const SMALL_CALL_GAS = 60_000n
const SMALL_RETURN_BYTES = 256

function byteLength(value: Hex): number {
  return (value.length - 2) / 2
}

function isNonEmptyCode(value: Hex | undefined): value is Hex {
  return value !== undefined && value !== '0x'
}

async function callBounded(client: OtcReaderClient, request: OtcReadCall, maxReturnBytes: number): Promise<Hex> {
  const response = await client.call(request)
  if (!response.data || byteLength(response.data) > maxReturnBytes) throw new Error('Ophis OTC call rejected')
  return response.data
}

async function requirePinnedChain(client: OtcReaderClient, manifest: OtcManifest): Promise<void> {
  const chainId = await client.getChainId()
  if (chainId !== manifest.chainId) throw new Error('Ophis OTC wrong chain')
}

async function requirePinnedCode(
  client: OtcReaderClient,
  address: Address,
  expectedHash: Hex,
  blockNumber: bigint,
): Promise<void> {
  const code = await client.getCode(address, blockNumber)
  if (!isNonEmptyCode(code) || keccak256(code) !== expectedHash) throw new Error('Ophis OTC source mismatch')
}

async function requireWethWiring(client: OtcReaderClient, manifest: OtcManifest, blockNumber: bigint): Promise<void> {
  const data = await callBounded(
    client,
    {
      to: manifest.contract.address,
      data: encodeFunctionData({ abi: OTC_READ_ABI, functionName: 'weth' }),
      gas: SMALL_CALL_GAS,
      blockNumber,
    },
    SMALL_RETURN_BYTES,
  )
  const wethAddress = decodeFunctionResult({ abi: OTC_READ_ABI, functionName: 'weth', data })
  if (!isAddressEqual(wethAddress, manifest.wethAddress)) throw new Error('Ophis OTC wiring mismatch')
}

async function readNextOrderId(client: OtcReaderClient, manifest: OtcManifest, blockNumber: bigint): Promise<bigint> {
  const data = await callBounded(
    client,
    {
      to: manifest.contract.address,
      data: encodeFunctionData({ abi: OTC_READ_ABI, functionName: 'nextOrderId' }),
      gas: SMALL_CALL_GAS,
      blockNumber,
    },
    SMALL_RETURN_BYTES,
  )
  return decodeFunctionResult({ abi: OTC_READ_ABI, functionName: 'nextOrderId', data })
}

/** Order ids are 0-based: enumerate newest-first from nextOrderId - 1 down to the window floor. */
function enumerationBatches(nextOrderId: bigint, manifest: OtcManifest): bigint[][] {
  const windowFloor =
    nextOrderId > BigInt(manifest.maxEnumeratedOrders) ? nextOrderId - BigInt(manifest.maxEnumeratedOrders) : 0n

  const batches: bigint[][] = []
  let batch: bigint[] = []
  for (let orderId = nextOrderId - 1n; orderId >= windowFloor; orderId -= 1n) {
    batch.push(orderId)
    if (batch.length === manifest.orderBatchSize) {
      batches.push(batch)
      batch = []
    }
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

async function readOrderBatch(
  client: OtcReaderClient,
  manifest: OtcManifest,
  orderIds: bigint[],
  blockNumber: bigint,
): Promise<OtcOrder[]> {
  const data = await callBounded(
    client,
    {
      to: manifest.contract.address,
      data: encodeFunctionData({ abi: OTC_READ_ABI, functionName: 'getOrders', args: [orderIds] }),
      gas: manifest.callGasLimit,
      blockNumber,
    },
    manifest.maxReturnBytes,
  )
  const decoded: unknown = decodeFunctionResult({ abi: OTC_READ_ABI, functionName: 'getOrders', data })
  return parseOtcOrders(decoded, orderIds)
}

export interface OtcOrderReadResult {
  order: OtcOrder | null
  blockNumber: bigint
  blockHash: Hex
}

export interface OtcVerifiedContract {
  blockNumber: bigint
  blockHash: Hex
}

/** Verify chain, runtime bytecode, WETH wiring, and block identity without enumerating orders. */
export async function verifyOtcContract(
  client: OtcReaderClient,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
): Promise<OtcVerifiedContract> {
  await requirePinnedChain(client, manifest)
  const block = await client.getLatestBlock()
  if (!block.hash) throw new Error('Ophis OTC block is not identifiable')

  await requirePinnedCode(client, manifest.contract.address, manifest.contract.runtimeCodeHash, block.number)
  await requireWethWiring(client, manifest, block.number)

  const confirmedBlock = await client.getBlockByNumber(block.number)
  if (confirmedBlock.number !== block.number || !confirmedBlock.hash || confirmedBlock.hash !== block.hash) {
    throw new Error('Ophis OTC block changed')
  }

  return { blockNumber: block.number, blockHash: block.hash }
}

/**
 * Direct, fail-closed read of one order — the fresh re-read the detail view
 * performs so an indexed row is never presented as current state. Enforces
 * the SAME guards as the snapshot reader: chain id, pinned runtime code hash, weth()
 * wiring, single-block pinning, and a post-read block-hash confirmation.
 */
export function readOtcOrder(
  client: OtcReaderClient,
  orderId: bigint,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
): Promise<OtcOrderReadResult> {
  return withTimeout(
    readVerifiedOtcOrder(client, orderId, manifest),
    manifest.readTimeoutMs,
    'Ophis OTC order read timed out',
  )
}

async function readVerifiedOtcOrder(
  client: OtcReaderClient,
  orderId: bigint,
  manifest: OtcManifest,
): Promise<OtcOrderReadResult> {
  await requirePinnedChain(client, manifest)
  const block = await client.getLatestBlock()
  if (!block.hash) throw new Error('Ophis OTC block is not identifiable')

  await requirePinnedCode(client, manifest.contract.address, manifest.contract.runtimeCodeHash, block.number)
  await requireWethWiring(client, manifest, block.number)

  const data = await callBounded(
    client,
    {
      to: manifest.contract.address,
      data: encodeFunctionData({ abi: OTC_READ_ABI, functionName: 'getOrder', args: [orderId] }),
      gas: SMALL_CALL_GAS,
      blockNumber: block.number,
    },
    1_024,
  )
  const decoded: unknown = decodeFunctionResult({ abi: OTC_READ_ABI, functionName: 'getOrder', data })
  const orders = parseOtcOrders([decoded], [orderId])

  const confirmedBlock = await client.getBlockByNumber(block.number)
  if (confirmedBlock.number !== block.number || !confirmedBlock.hash || confirmedBlock.hash !== block.hash) {
    throw new Error('Ophis OTC block changed')
  }

  return { order: orders[0] ?? null, blockNumber: block.number, blockHash: block.hash }
}

/**
 * Single-block, fail-closed snapshot of the escrow contract's order state.
 * Verifies the pinned runtime code hash and weth() wiring before reading
 * anything, pins every call to one block, and re-reads the block afterwards
 * so a reorg under the read cannot produce a mixed snapshot.
 */
export async function readOtcSnapshot(
  client: OtcReaderClient,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
): Promise<OtcSnapshot> {
  await requirePinnedChain(client, manifest)
  const block = await client.getLatestBlock()
  if (!block.hash) throw new Error('Ophis OTC block is not identifiable')

  await requirePinnedCode(client, manifest.contract.address, manifest.contract.runtimeCodeHash, block.number)
  await requireWethWiring(client, manifest, block.number)

  const nextOrderId = await readNextOrderId(client, manifest, block.number)

  const orders: OtcOrder[] = []
  for (const orderIds of enumerationBatches(nextOrderId, manifest)) {
    orders.push(...(await readOrderBatch(client, manifest, orderIds, block.number)))
  }

  const confirmedBlock = await client.getBlockByNumber(block.number)
  if (confirmedBlock.number !== block.number || !confirmedBlock.hash || confirmedBlock.hash !== block.hash) {
    throw new Error('Ophis OTC block changed')
  }

  return {
    chainId: manifest.chainId,
    blockNumber: block.number,
    blockHash: block.hash,
    nextOrderId,
    orders,
    truncated: nextOrderId > BigInt(manifest.maxEnumeratedOrders),
  }
}
