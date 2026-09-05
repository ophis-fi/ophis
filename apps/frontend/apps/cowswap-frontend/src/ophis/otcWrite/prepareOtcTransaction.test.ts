import { USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'

import { OTC_FILL_DEADLINE_WINDOW_SECONDS } from './buildOtcTransaction'
import { prepareOtcTransaction } from './prepareOtcTransaction'
import {
  MAKER,
  mockOtcManifest,
  mockOtcOrder,
  mockOtcWriteClient,
  NOW,
  type MockOtcPreflightState,
} from './prepareOtcTransactionTest.utils'

const TAKER = '0x1111111111111111111111111111111111111111'

describe('Milestone C transaction preflight', () => {
  it('fails a stalled preflight closed within the bounded timeout', async () => {
    jest.useFakeTimers()
    try {
      const client = mockOtcWriteClient()
      client.simulate = () => new Promise(() => undefined)
      const preflight = prepareOtcTransaction(
        client,
        { kind: 'fill', account: TAKER, order: mockOtcOrder(), deadline: NOW + 180n },
        mockOtcManifest(),
      )
      const rejection = expect(preflight).rejects.toThrow('Ophis OTC transaction preflight timed out')

      await jest.advanceTimersByTimeAsync(30_000)
      await rejection
    } finally {
      jest.useRealTimers()
    }
  })

  it('re-reads an order and simulates the exact fill before returning a request', async () => {
    const state: MockOtcPreflightState = { simulated: [] }
    const result = await prepareOtcTransaction(
      mockOtcWriteClient(state),
      { kind: 'fill', account: TAKER, order: mockOtcOrder(), deadline: NOW + 180n },
      mockOtcManifest(),
    )

    expect(result.simulatedAtBlock).toBe(200n)
    expect(result.preparedAtTimestamp).toBe(NOW)
    expect(state.simulated).toEqual([result.request])
  })

  it('derives a short fill deadline from the verified fork block timestamp', async () => {
    const result = await prepareOtcTransaction(
      mockOtcWriteClient({ blockTimestamp: NOW, simulated: [] }),
      { kind: 'fill', account: TAKER, order: mockOtcOrder(), deadline: 1n },
      mockOtcManifest(),
    )

    expect(result.intent).toMatchObject({ kind: 'fill', deadline: NOW + OTC_FILL_DEADLINE_WINDOW_SECONDS })
  })

  it('rejects a raced or changed order before simulation', async () => {
    const state: MockOtcPreflightState = {
      current: mockOtcOrder({ amountB: mockOtcOrder().amountB + 1n }),
      simulated: [],
    }
    await expect(
      prepareOtcTransaction(
        mockOtcWriteClient(state),
        { kind: 'fill', account: TAKER, order: mockOtcOrder(), deadline: NOW + 180n },
        mockOtcManifest(),
      ),
    ).rejects.toThrow('Ophis OTC order changed before submission')
    expect(state.simulated).toEqual([])
  })

  it('verifies source identity and simulates create without enumerating orders', async () => {
    const state: MockOtcPreflightState = { simulated: [], allowance: 1n }
    const result = await prepareOtcTransaction(
      mockOtcWriteClient(state),
      {
        kind: 'create',
        account: MAKER,
        draft: { tokenA: WETH_MAINNET.address, amountA: 1n, tokenB: USDC_MAINNET.address, amountB: 2n },
      },
      mockOtcManifest(),
    )
    expect(state.simulated).toEqual([result.request])
  })

  it('rejects execution unless the allowance equals the exact transfer amount', async () => {
    const expected = mockOtcOrder()
    const state: MockOtcPreflightState = { simulated: [], allowance: expected.amountB + 1n }
    await expect(
      prepareOtcTransaction(
        mockOtcWriteClient(state),
        { kind: 'fill', account: TAKER, order: expected, deadline: NOW + 180n },
        mockOtcManifest(),
      ),
    ).rejects.toThrow('Ophis OTC exact allowance required')
    expect(state.simulated).toEqual([])
  })

  it('rechecks that allowance is zero immediately before an approval', async () => {
    const expected = mockOtcOrder()
    const positive: MockOtcPreflightState = { simulated: [], allowance: 1n }
    await expect(
      prepareOtcTransaction(
        mockOtcWriteClient(positive),
        { kind: 'approve-fill', account: TAKER, order: expected },
        mockOtcManifest(),
      ),
    ).rejects.toThrow('Ophis OTC exact allowance required')
    expect(positive.simulated).toEqual([])

    const zero: MockOtcPreflightState = { simulated: [], allowance: 0n }
    const approved = await prepareOtcTransaction(
      mockOtcWriteClient(zero),
      { kind: 'approve-fill', account: TAKER, order: expected },
      mockOtcManifest(),
    )
    expect(zero.simulated).toEqual([approved.request])
  })

  it('rejects a block identity change after final simulation', async () => {
    const state: MockOtcPreflightState = {
      simulated: [],
      finalBlockHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
    }
    await expect(
      prepareOtcTransaction(
        mockOtcWriteClient(state),
        { kind: 'fill', account: TAKER, order: mockOtcOrder(), deadline: NOW + 180n },
        mockOtcManifest(),
      ),
    ).rejects.toThrow('Ophis OTC block changed')
    expect(state.simulated).toHaveLength(1)
  })

  it('allows safe allowance revocation after a raced fill made the order inactive', async () => {
    const stale = mockOtcOrder({ active: false })
    const state: MockOtcPreflightState = { current: stale, simulated: [] }
    const result = await prepareOtcTransaction(
      mockOtcWriteClient(state),
      { kind: 'revoke-fill', account: TAKER, order: stale },
      mockOtcManifest(),
    )

    expect(result.request.kind).toBe('revoke-fill')
    expect(state.simulated).toEqual([result.request])
  })

  it('rejects allowance revocation when the current fork allowance is already zero', async () => {
    const inactive = mockOtcOrder({ active: false })
    const state: MockOtcPreflightState = { current: inactive, simulated: [], allowance: 0n }
    await expect(
      prepareOtcTransaction(
        mockOtcWriteClient(state),
        { kind: 'revoke-fill', account: TAKER, order: inactive },
        mockOtcManifest(),
      ),
    ).rejects.toThrow('Ophis OTC exact allowance required')
    expect(state.simulated).toEqual([])
  })
})
