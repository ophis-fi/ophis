import { USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'

import { OTC_FILL_DEADLINE_WINDOW_SECONDS } from './buildOtcTransaction'
import { prepareOtcTransaction, submitOtcTransaction } from './prepareOtcTransaction'
import {
  MAKER,
  mockOtcAuthorization,
  mockOtcManifest,
  mockOtcOrder,
  mockOtcWriteClient,
  NOW,
  TX_HASH,
  type MockOtcPreflightState,
} from './prepareOtcTransactionTest.utils'

jest.mock('@cowprotocol/common-utils', () => ({
  ...jest.requireActual('@cowprotocol/common-utils'),
  isLocal: true,
}))

import type { OtcWalletSubmitter } from './otcWrite.types'

const TAKER = '0x1111111111111111111111111111111111111111'

describe('Milestone C preflight and submission', () => {
  beforeAll(() => {
    process.env.REACT_APP_OTC_WRITE_MODE = 'fork'
  })

  afterAll(() => {
    delete process.env.REACT_APP_OTC_WRITE_MODE
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

  it('never reaches the wallet unless every independent write boundary is enabled', async () => {
    const wallet: OtcWalletSubmitter = {
      sendTransaction: jest.fn(async () => TX_HASH),
      waitForTransactionReceipt: jest.fn(async () => ({
        transactionHash: TX_HASH,
        status: 'success',
        blockNumber: 201n,
      })),
    }
    const intent = {
      kind: 'cancel' as const,
      account: MAKER,
      order: mockOtcOrder(),
    }
    const denied = [
      mockOtcAuthorization({ readFlag: false }),
      mockOtcAuthorization({ writeFlag: false }),
      mockOtcAuthorization({ isLocal: false }),
      mockOtcAuthorization({ writeMode: 'production' }),
    ]

    for (const auth of denied) {
      await expect(submitOtcTransaction(mockOtcWriteClient(), wallet, intent, auth, mockOtcManifest())).rejects.toThrow(
        'Ophis OTC writes are disabled',
      )
    }
    expect(wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('never reaches the wallet when the actual build mode is not fork, even if caller input matches it', async () => {
    const wallet: OtcWalletSubmitter = {
      sendTransaction: jest.fn(async () => TX_HASH),
      waitForTransactionReceipt: jest.fn(async () => ({
        transactionHash: TX_HASH,
        status: 'success',
        blockNumber: 201n,
      })),
    }

    process.env.REACT_APP_OTC_WRITE_MODE = 'production'
    try {
      await expect(
        submitOtcTransaction(
          mockOtcWriteClient(),
          wallet,
          { kind: 'cancel', account: MAKER, order: mockOtcOrder() },
          mockOtcAuthorization({ writeMode: 'production' }),
          mockOtcManifest(),
        ),
      ).rejects.toThrow('Ophis OTC writes are disabled')
    } finally {
      process.env.REACT_APP_OTC_WRITE_MODE = 'fork'
    }

    expect(wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('submits only after simulation and waits through receipt confirmation', async () => {
    const calls: string[] = []
    const writeClient = mockOtcWriteClient()
    writeClient.simulate = async () => {
      calls.push('simulate')
    }
    const wallet: OtcWalletSubmitter = {
      sendTransaction: async () => {
        calls.push('send')
        return TX_HASH
      },
      waitForTransactionReceipt: async () => {
        calls.push('receipt')
        return { transactionHash: TX_HASH, status: 'success', blockNumber: 201n }
      },
    }

    const receipt = await submitOtcTransaction(
      writeClient,
      wallet,
      { kind: 'cancel', account: MAKER, order: mockOtcOrder() },
      mockOtcAuthorization(),
      mockOtcManifest(),
    )
    expect(calls).toEqual(['simulate', 'send', 'receipt'])
    expect(receipt.transactionHash).toBe(TX_HASH)
  })

  it('treats a reverted receipt as failure', async () => {
    const wallet: OtcWalletSubmitter = {
      sendTransaction: async () => TX_HASH,
      waitForTransactionReceipt: async () => ({ transactionHash: TX_HASH, status: 'reverted', blockNumber: 201n }),
    }
    await expect(
      submitOtcTransaction(
        mockOtcWriteClient(),
        wallet,
        { kind: 'cancel', account: MAKER, order: mockOtcOrder() },
        mockOtcAuthorization(),
        mockOtcManifest(),
      ),
    ).rejects.toThrow('Ophis OTC transaction reverted')
  })
})
