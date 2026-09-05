import { USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'

import { OPHIS_ETHEREUM_OTC_MANIFEST, OTC_READ_ABI } from 'ophis/otc'
import { decodeFunctionData, encodeFunctionResult, keccak256, type Hex } from 'viem'

import { OTC_ALLOWANCE_ABI } from './otcWrite.abi'

import type { OtcTransactionRequest, OtcWriteClient, OtcWriteRuntimeAuthorization } from './otcWrite.types'
import type { OtcManifest, OtcOrder } from 'ophis/otc'

const MOCK_CODE: Hex = '0x600160015500'
const BLOCK_HASH: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111'

export const TX_HASH: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const MAKER = '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9'
export const NOW = 1_755_792_000n

export interface MockOtcPreflightState {
  current?: OtcOrder
  simulated?: OtcTransactionRequest[]
  allowance?: bigint
  blockTimestamp?: bigint
  finalBlockHash?: Hex
}

export function mockOtcManifest(): OtcManifest {
  return {
    ...OPHIS_ETHEREUM_OTC_MANIFEST,
    contract: { ...OPHIS_ETHEREUM_OTC_MANIFEST.contract, runtimeCodeHash: keccak256(MOCK_CODE) },
  }
}

export function mockOtcOrder(overrides: Partial<OtcOrder> = {}): OtcOrder {
  return {
    orderId: 144n,
    maker: MAKER,
    active: true,
    tokenA: WETH_MAINNET.address,
    amountA: 2n * 10n ** 18n,
    tokenB: USDC_MAINNET.address,
    amountB: 8_000n * 10n ** 6n,
    ...overrides,
  }
}

export function mockOtcWriteClient(state: MockOtcPreflightState = {}): OtcWriteClient {
  const current = state.current ?? mockOtcOrder()
  let blockReads = 0
  return {
    getChainId: async () => 1,
    getLatestBlock: async () => ({ number: 200n, hash: BLOCK_HASH, timestamp: state.blockTimestamp ?? NOW }),
    getBlockByNumber: async (blockNumber) => {
      blockReads += 1
      return {
        number: blockNumber,
        hash: blockReads > 2 ? (state.finalBlockHash ?? BLOCK_HASH) : BLOCK_HASH,
        timestamp: state.blockTimestamp ?? NOW,
      }
    },
    getCode: async () => MOCK_CODE,
    call: async (request) => {
      if (request.to !== OPHIS_ETHEREUM_OTC_MANIFEST.contract.address) {
        const decoded = decodeFunctionData({ abi: OTC_ALLOWANCE_ABI, data: request.data })
        if (decoded.functionName !== 'allowance') throw new Error(`unexpected token call: ${decoded.functionName}`)
        return {
          data: encodeFunctionResult({
            abi: OTC_ALLOWANCE_ABI,
            functionName: 'allowance',
            result: state.allowance ?? current.amountB,
          }),
        }
      }
      const decoded = decodeFunctionData({ abi: OTC_READ_ABI, data: request.data })
      if (decoded.functionName === 'weth') {
        return {
          data: encodeFunctionResult({
            abi: OTC_READ_ABI,
            functionName: 'weth',
            result: OPHIS_ETHEREUM_OTC_MANIFEST.wethAddress,
          }),
        }
      }
      if (decoded.functionName === 'getOrder') {
        return {
          data: encodeFunctionResult({
            abi: OTC_READ_ABI,
            functionName: 'getOrder',
            result: {
              maker: current.maker,
              active: current.active,
              tokenA: current.tokenA,
              amountA: current.amountA,
              tokenB: current.tokenB,
              amountB: current.amountB,
            },
          }),
        }
      }
      throw new Error(`unexpected call: ${String(decoded.functionName)}`)
    },
    simulate: async (request, blockNumber) => {
      if (blockNumber !== 200n) throw new Error(`unexpected simulation block ${blockNumber.toString()}`)
      state.simulated?.push(request)
    },
  }
}

export function mockOtcAuthorization(
  overrides: Partial<OtcWriteRuntimeAuthorization> = {},
): OtcWriteRuntimeAuthorization {
  return { isLocal: true, readFlag: true, writeFlag: true, writeMode: 'fork', ...overrides }
}
