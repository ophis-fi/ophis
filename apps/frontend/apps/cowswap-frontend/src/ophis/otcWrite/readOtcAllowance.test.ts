import { USDC_MAINNET } from '@cowprotocol/common-const'

import { OPHIS_ETHEREUM_OTC_MANIFEST, OTC_READ_ABI } from 'ophis/otc'
import { decodeFunctionData, encodeFunctionResult, keccak256, type Hex } from 'viem'

import { OTC_ALLOWANCE_ABI } from './otcWrite.abi'
import { readOtcAllowance } from './readOtcAllowance'

import type { OtcWriteClient } from './otcWrite.types'
import type { OtcManifest } from 'ophis/otc'

const OWNER = '0x1111111111111111111111111111111111111111'
const BLOCK_HASH: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111'
const MOCK_CODE: Hex = '0x600160015500'

function manifest(): OtcManifest {
  return {
    ...OPHIS_ETHEREUM_OTC_MANIFEST,
    contract: { ...OPHIS_ETHEREUM_OTC_MANIFEST.contract, runtimeCodeHash: keccak256(MOCK_CODE) },
  }
}

function client(result = 42n, finalBlockHash: Hex = BLOCK_HASH): OtcWriteClient {
  let blockReads = 0
  return {
    getChainId: async () => 1,
    getLatestBlock: async () => ({ number: 200n, hash: BLOCK_HASH, timestamp: 1_755_792_000n }),
    getBlockByNumber: async (blockNumber) => {
      blockReads += 1
      return { number: blockNumber, hash: blockReads > 1 ? finalBlockHash : BLOCK_HASH, timestamp: 1_755_792_000n }
    },
    getCode: async () => MOCK_CODE,
    call: async (request) => {
      if (request.to === OPHIS_ETHEREUM_OTC_MANIFEST.contract.address) {
        expect(decodeFunctionData({ abi: OTC_READ_ABI, data: request.data }).functionName).toBe('weth')
        return {
          data: encodeFunctionResult({
            abi: OTC_READ_ABI,
            functionName: 'weth',
            result: OPHIS_ETHEREUM_OTC_MANIFEST.wethAddress,
          }),
        }
      }
      const decoded = decodeFunctionData({ abi: OTC_ALLOWANCE_ABI, data: request.data })
      expect(decoded).toEqual({
        functionName: 'allowance',
        args: [OWNER, OPHIS_ETHEREUM_OTC_MANIFEST.contract.address],
      })
      expect(request.blockNumber).toBe(200n)
      return { data: encodeFunctionResult({ abi: OTC_ALLOWANCE_ABI, functionName: 'allowance', result }) }
    },
    simulate: async () => undefined,
  }
}

describe('readOtcAllowance', () => {
  it('reads an exact reviewed-token allowance at the verified source block', async () => {
    await expect(readOtcAllowance(client(), USDC_MAINNET.address, OWNER, manifest())).resolves.toEqual({
      allowance: 42n,
      blockNumber: 200n,
    })
  })

  it('fails closed for an unreviewed token before making an allowance call', async () => {
    const writeClient = client()
    const call = jest.spyOn(writeClient, 'call')
    await expect(
      readOtcAllowance(writeClient, '0x000000000000040470635EB91b7CE4D132D616eD', OWNER, manifest()),
    ).rejects.toThrow(/token policy blocked/)
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects malformed allowance returndata', async () => {
    const writeClient = client()
    const validCall = writeClient.call
    writeClient.call = async (request) => (request.to === USDC_MAINNET.address ? { data: '0x01' } : validCall(request))
    await expect(readOtcAllowance(writeClient, USDC_MAINNET.address, OWNER, manifest())).rejects.toThrow(
      'Ophis OTC allowance read rejected',
    )
  })

  it('rejects a block identity change during the allowance read', async () => {
    await expect(
      readOtcAllowance(
        client(42n, '0x2222222222222222222222222222222222222222222222222222222222222222'),
        USDC_MAINNET.address,
        OWNER,
        manifest(),
      ),
    ).rejects.toThrow('Ophis OTC block changed')
  })
})
