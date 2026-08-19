import { readFileSync } from 'fs'
import { join } from 'path'

import { decodeFunctionResult } from 'viem'

import { OTC_READ_ABI } from './otc.abi'
import { parseOtcOrders } from './parseOtcOrders'

import type { Hex } from 'viem'

interface RecordedCall {
  responseHex: Hex
  orderIds?: string[]
}

function loadFixture(name: string): RecordedCall {
  return JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8')) as RecordedCall
}

const BATCH_IDS = [0n, 130n, 139n, 141n, 143n, 999n]

function decodeBatchFixture(): unknown {
  const fixture = loadFixture('getOrders-batch.json')
  return decodeFunctionResult({ abi: OTC_READ_ABI, functionName: 'getOrders', data: fixture.responseHex })
}

describe('parseOtcOrders', () => {
  it('parses the recorded mainnet batch, dropping non-existent orders', () => {
    const orders = parseOtcOrders(decodeBatchFixture(), BATCH_IDS)

    // Order ids are 0-based: id 0 is a real resolved order (1 USDC -> 0.0003
    // WETH). Only id 999 returns the default struct (zero maker) and drops.
    expect(orders.map((order) => order.orderId)).toEqual([0n, 130n, 139n, 141n, 143n])

    const order0 = orders.find((order) => order.orderId === 0n)
    expect(order0).toEqual({
      orderId: 0n,
      maker: '0x2eDecb91091324e0138EBBBaEd48ce1B2A050428',
      active: false,
      tokenA: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountA: 1_000_000n,
      tokenB: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      amountB: 300_000_000_000_000n,
    })

    const order143 = orders.find((order) => order.orderId === 143n)
    expect(order143).toEqual({
      orderId: 143n,
      maker: '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9',
      active: true,
      tokenA: '0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED',
      amountA: 100_000_000_000_000_000_000n,
      tokenB: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      amountB: 1_000_000_000_000_000_000n,
    })

    const order139 = orders.find((order) => order.orderId === 139n)
    expect(order139?.active).toBe(false)
    const order141 = orders.find((order) => order.orderId === 141n)
    expect(order141?.active).toBe(false)
    const order130 = orders.find((order) => order.orderId === 130n)
    expect(order130?.active).toBe(true)
    expect(order130?.tokenA).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
    expect(order130?.tokenB).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
  })

  it('rejects a row count that disagrees with the requested ids', () => {
    expect(() => parseOtcOrders(decodeBatchFixture(), [0n, 130n])).toThrow('Ophis OTC order decode rejected')
  })

  it('rejects rows with malformed field types', () => {
    const valid = {
      maker: '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9',
      active: true,
      tokenA: '0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED',
      amountA: 1n,
      tokenB: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      amountB: 1n,
    }

    expect(() => parseOtcOrders([{ ...valid, maker: 'not-an-address' }], [1n])).toThrow(
      'Ophis OTC order decode rejected',
    )
    expect(() => parseOtcOrders([{ ...valid, active: 1 }], [1n])).toThrow('Ophis OTC order decode rejected')
    expect(() => parseOtcOrders([{ ...valid, amountA: -1n }], [1n])).toThrow('Ophis OTC order decode rejected')
    expect(() => parseOtcOrders([{ ...valid, amountB: '1' }], [1n])).toThrow('Ophis OTC order decode rejected')
    expect(() => parseOtcOrders(['nonsense'], [1n])).toThrow('Ophis OTC order decode rejected')
    expect(() => parseOtcOrders('not-an-array', [1n])).toThrow('Ophis OTC order decode rejected')
  })

  it('normalizes addresses to EIP-55 checksum form', () => {
    const lowercased = {
      maker: '0x9a50a078d80f36e38edfae85affa2b8ab458e2c9',
      active: true,
      tokenA: '0xe9b1cfea55baa219e34301f2f31b9fd0921664ed',
      amountA: 1n,
      tokenB: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
      amountB: 1n,
    }
    const [order] = parseOtcOrders([lowercased], [7n])
    expect(order.maker).toBe('0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9')
    expect(order.tokenA).toBe('0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED')
    expect(order.tokenB).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
  })
})
