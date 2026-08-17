import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { decodeFunctionResult, encodeFunctionData, keccak256, type Address, type Hex } from 'viem'

import { OPHIS_DISCOVERY_ABI } from './ophisDiscovery.abi'
import { OPHIS_ETHEREUM_DISCOVERY_MANIFEST } from './ophisDiscovery.const'
import { isNonEmptyCode, parseOphisDiscoveryPage } from './parseOphisDiscoveryPage'

import type {
  OphisDiscoveryCall,
  OphisDiscoveryManifest,
  OphisDiscoveryReaderClient,
  OphisDiscoverySnapshot,
  OphisDiscoveredToken,
} from './ophisDiscovery.types'

function byteLength(value: Hex): number {
  return (value.length - 2) / 2
}

async function callBounded(
  client: OphisDiscoveryReaderClient,
  request: OphisDiscoveryCall,
  maxReturnBytes: number,
): Promise<Hex> {
  const response = await client.call(request)
  if (!response.data || byteLength(response.data) > maxReturnBytes) throw new Error('Ophis discovery call rejected')
  return response.data
}

async function requirePinnedCode(
  client: OphisDiscoveryReaderClient,
  address: Address,
  expectedHash: Hex,
  blockNumber: bigint,
): Promise<void> {
  const code = await client.getCode(address, blockNumber)
  if (!isNonEmptyCode(code) || keccak256(code) !== expectedHash) throw new Error('Ophis discovery source mismatch')
}

async function retainContracts(
  client: OphisDiscoveryReaderClient,
  tokens: OphisDiscoveredToken[],
  blockNumber: bigint,
): Promise<OphisDiscoveredToken[]> {
  const code = await Promise.all(tokens.map((token) => client.getCode(token.address, blockNumber)))
  return tokens.filter((_, index) => isNonEmptyCode(code[index]))
}

export async function readOphisDiscovery(
  client: OphisDiscoveryReaderClient,
  manifest: OphisDiscoveryManifest = OPHIS_ETHEREUM_DISCOVERY_MANIFEST,
): Promise<OphisDiscoverySnapshot> {
  const block = await client.getLatestBlock()
  if (!block.hash) throw new Error('Ophis discovery block is not final enough to identify')

  await Promise.all([
    requirePinnedCode(client, manifest.registry.address, manifest.registry.runtimeCodeHash, block.number),
    requirePinnedCode(client, manifest.lens.address, manifest.lens.runtimeCodeHash, block.number),
    requirePinnedCode(client, manifest.ranking.address, manifest.ranking.runtimeCodeHash, block.number),
  ])

  const sourceData = await callBounded(
    client,
    {
      to: manifest.lens.address,
      data: encodeFunctionData({ abi: OPHIS_DISCOVERY_ABI, functionName: 'tokenList' }),
      gas: 60_000n,
      blockNumber: block.number,
    },
    256,
  )
  const sourceAddress = decodeFunctionResult({
    abi: OPHIS_DISCOVERY_ABI,
    functionName: 'tokenList',
    data: sourceData,
  })
  if (!areAddressesEqual(sourceAddress, manifest.registry.address)) throw new Error('Ophis discovery wiring mismatch')

  const rankingData = await callBounded(
    client,
    {
      to: manifest.lens.address,
      data: encodeFunctionData({ abi: OPHIS_DISCOVERY_ABI, functionName: 'conviction' }),
      gas: 60_000n,
      blockNumber: block.number,
    },
    256,
  )
  const rankingAddress = decodeFunctionResult({
    abi: OPHIS_DISCOVERY_ABI,
    functionName: 'conviction',
    data: rankingData,
  })
  if (!areAddressesEqual(rankingAddress, manifest.ranking.address)) throw new Error('Ophis discovery wiring mismatch')

  const pageData = await callBounded(
    client,
    {
      to: manifest.lens.address,
      data: encodeFunctionData({
        abi: OPHIS_DISCOVERY_ABI,
        functionName: 'summariesPaged',
        args: [0n, BigInt(manifest.pageSize)],
      }),
      gas: manifest.callGasLimit,
      blockNumber: block.number,
    },
    manifest.maxReturnBytes,
  )
  const decodedPage: unknown = decodeFunctionResult({
    abi: OPHIS_DISCOVERY_ABI,
    functionName: 'summariesPaged',
    data: pageData,
  })
  const tokens = await retainContracts(client, parseOphisDiscoveryPage(decodedPage, manifest.chainId), block.number)

  const confirmedBlock = await client.getBlockByNumber(block.number)
  if (confirmedBlock.number !== block.number || !confirmedBlock.hash || confirmedBlock.hash !== block.hash) {
    throw new Error('Ophis discovery block changed')
  }

  return {
    chainId: manifest.chainId,
    chainLabel: manifest.chainLabel,
    blockNumber: block.number,
    blockHash: block.hash,
    tokens,
  }
}
