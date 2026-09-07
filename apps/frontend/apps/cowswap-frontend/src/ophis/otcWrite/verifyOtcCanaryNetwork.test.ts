import { mockOtcWriteClient, NOW } from './prepareOtcTransactionTest.utils'
import { verifyOtcCanaryNetwork } from './verifyOtcCanaryNetwork'

import type { OtcReaderClient } from 'ophis/otc'

describe('OTC canonical Ethereum verification', () => {
  beforeEach(() => jest.useFakeTimers({ now: Number(NOW) * 1_000 }))
  afterEach(() => jest.useRealTimers())

  it('accepts a current matching Ethereum block, including a two-block RPC lag', async () => {
    const connected = mockOtcWriteClient()
    const canonical = mockOtcWriteClient()
    const head = await canonical.getLatestBlock()
    canonical.getLatestBlock = async () => ({ ...head, number: head.number + 2n })
    await expect(verifyOtcCanaryNetwork(connected, canonical)).resolves.toBeUndefined()
  })

  it.each(['connected', 'canonical'])('rejects a non-Ethereum %s reader', async (side) => {
    const connected = mockOtcWriteClient()
    const canonical = mockOtcWriteClient()
    ;(side === 'connected' ? connected : canonical).getChainId = async () => 31337
    await expect(verifyOtcCanaryNetwork(connected, canonical)).rejects.toThrow('wrong chain')
  })

  it.each([{ hash: null }, { hash: `0x${'cc'.repeat(32)}` as const }, { number: 201n }, { timestamp: NOW - 1n }])(
    'rejects divergent canonical block identity: %s',
    async (change) => {
      const connected = mockOtcWriteClient()
      const canonical = mockOtcWriteClient()
      const head = await canonical.getLatestBlock()
      canonical.getBlockByNumber = async () => ({ ...head, ...change })
      await expect(verifyOtcCanaryNetwork(connected, canonical)).rejects.toThrow('does not match')
    },
  )

  it.each([-121n, 31n])('rejects matching but stale or future heads: %s seconds', async (offset) => {
    const connected = mockOtcWriteClient({ blockTimestamp: NOW + offset })
    const canonical = mockOtcWriteClient({ blockTimestamp: NOW + offset })
    await expect(verifyOtcCanaryNetwork(connected, canonical)).rejects.toThrow('does not match')
  })

  it.each([199n, 203n])('rejects a wallet head ahead of, or too far behind, canonical head %s', async (number) => {
    const connected = mockOtcWriteClient()
    const canonical = mockOtcWriteClient()
    const head = await canonical.getLatestBlock()
    canonical.getLatestBlock = async () => ({ ...head, number })
    await expect(verifyOtcCanaryNetwork(connected, canonical)).rejects.toThrow('does not match')
  })

  it('bounds a stalled canonical RPC so the UI can recover', async () => {
    const canonical = { getChainId: () => new Promise(() => undefined) } as OtcReaderClient
    const result = verifyOtcCanaryNetwork(mockOtcWriteClient(), canonical)
    const assertion = expect(result).rejects.toThrow('Ethereum verification timed out')
    await jest.advanceTimersByTimeAsync(8_000)
    await assertion
  })
})
