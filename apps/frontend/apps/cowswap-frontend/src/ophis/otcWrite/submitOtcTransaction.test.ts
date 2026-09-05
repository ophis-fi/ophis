import { OtcReceiptTrackingError } from './otcReceiptTrackingError'
import { submitOtcTransaction } from './prepareOtcTransaction'
import {
  MAKER,
  mockOtcAuthorization,
  mockOtcManifest,
  mockOtcOrder,
  mockOtcWriteClient,
  TX_HASH,
} from './prepareOtcTransactionTest.utils'

import type { OtcWalletSubmitter } from './otcWrite.types'

jest.mock('@cowprotocol/common-utils', () => ({
  ...jest.requireActual('@cowprotocol/common-utils'),
  isLocal: true,
}))

describe('Milestone C wallet submission sink', () => {
  beforeAll(() => {
    process.env.REACT_APP_OTC_WRITE_MODE = 'fork'
  })

  afterAll(() => {
    delete process.env.REACT_APP_OTC_WRITE_MODE
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
    const intent = { kind: 'cancel' as const, account: MAKER, order: mockOtcOrder() }
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
      undefined,
      () => calls.push('broadcast'),
    )
    expect(calls).toEqual(['simulate', 'send', 'broadcast', 'receipt'])
    expect(receipt.transactionHash).toBe(TX_HASH)
  })

  it('never submits when a timed-out preflight resolves later', async () => {
    jest.useFakeTimers()
    try {
      let resolveSimulation: (() => void) | undefined
      const writeClient = mockOtcWriteClient()
      writeClient.simulate = () =>
        new Promise((resolve) => {
          resolveSimulation = resolve
        })
      const wallet: OtcWalletSubmitter = {
        sendTransaction: jest.fn(async () => TX_HASH),
        waitForTransactionReceipt: jest.fn(async () => ({
          transactionHash: TX_HASH,
          status: 'success',
          blockNumber: 201n,
        })),
      }
      const submission = submitOtcTransaction(
        writeClient,
        wallet,
        { kind: 'cancel', account: MAKER, order: mockOtcOrder() },
        mockOtcAuthorization(),
        mockOtcManifest(),
      )
      const rejection = expect(submission).rejects.toThrow('Ophis OTC transaction preflight timed out')

      await jest.advanceTimersByTimeAsync(30_000)
      await rejection
      resolveSimulation?.()
      await Promise.resolve()

      expect(wallet.sendTransaction).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('propagates the current-context guard through the wallet sink', async () => {
    const sendTransaction: OtcWalletSubmitter['sendTransaction'] = jest.fn(
      async (_request, _intent, _nowSeconds, isCurrentContext) => {
        if (!isCurrentContext?.()) throw new Error('Ophis OTC action context changed')
        return TX_HASH
      },
    )
    const wallet: OtcWalletSubmitter = {
      sendTransaction,
      waitForTransactionReceipt: jest.fn(async () => ({
        transactionHash: TX_HASH,
        status: 'success',
        blockNumber: 201n,
      })),
    }
    const isCurrentContext = jest.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)

    await expect(
      submitOtcTransaction(
        mockOtcWriteClient(),
        wallet,
        { kind: 'cancel', account: MAKER, order: mockOtcOrder() },
        mockOtcAuthorization(),
        mockOtcManifest(),
        isCurrentContext,
      ),
    ).rejects.toThrow('Ophis OTC action context changed')
    expect(sendTransaction).toHaveBeenCalledTimes(1)
    expect(wallet.waitForTransactionReceipt).not.toHaveBeenCalled()
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

  it('preserves the broadcast hash when receipt tracking fails', async () => {
    const wallet: OtcWalletSubmitter = {
      sendTransaction: async () => TX_HASH,
      waitForTransactionReceipt: async () => {
        throw new Error('receipt RPC unavailable')
      },
    }

    await expect(
      submitOtcTransaction(
        mockOtcWriteClient(),
        wallet,
        { kind: 'cancel', account: MAKER, order: mockOtcOrder() },
        mockOtcAuthorization(),
        mockOtcManifest(),
      ),
    ).rejects.toMatchObject<OtcReceiptTrackingError>({ transactionHash: TX_HASH })
  })

  it('keeps the original hash locked when a successful replacement receipt is returned', async () => {
    const wallet: OtcWalletSubmitter = {
      sendTransaction: async () => TX_HASH,
      waitForTransactionReceipt: async () => ({
        transactionHash: `0x${'ab'.repeat(32)}`,
        status: 'success',
        blockNumber: 201n,
      }),
    }

    await expect(
      submitOtcTransaction(
        mockOtcWriteClient(),
        wallet,
        { kind: 'cancel', account: MAKER, order: mockOtcOrder() },
        mockOtcAuthorization(),
        mockOtcManifest(),
      ),
    ).rejects.toMatchObject<OtcReceiptTrackingError>({ transactionHash: TX_HASH })
  })
})
