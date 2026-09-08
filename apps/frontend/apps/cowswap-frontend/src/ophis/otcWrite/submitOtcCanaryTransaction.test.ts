import { OTC_CANARY_POLICY } from './otcCanary.const'
import { otcRequestHash } from './otcTransactionProof'
import { submitOtcTransaction } from './prepareOtcTransaction'
import {
  MAKER,
  mockOtcAuthorization,
  mockOtcManifest,
  mockOtcOrder,
  mockOtcWriteClient,
  NOW,
  TX_HASH,
} from './prepareOtcTransactionTest.utils'

import type { OtcWriteIntent, OtcWalletSubmitter } from './otcWrite.types'

jest.mock('@cowprotocol/common-utils', () => ({ ...jest.requireActual('@cowprotocol/common-utils'), isLocal: false }))
const originalFetch = global.fetch
jest.mock('./otcCanary.const', () => ({ OTC_CANARY_POLICY: { accounts: [], pairs: [], expiresAt: 0n } }))

const order = mockOtcOrder()
const intent: OtcWriteIntent = { kind: 'create', account: MAKER, draft: order }
const auth = mockOtcAuthorization({ isLocal: false })
const policy = OTC_CANARY_POLICY as { accounts: string[]; pairs: unknown[]; expiresAt: bigint }

function wallet(): jest.Mocked<OtcWalletSubmitter> {
  return {
    sendTransaction: jest.fn(async (_request, _intent, _timestamp, current, onPrompt) => {
      if (!current?.()) throw new Error('Ophis OTC action context changed')
      onPrompt?.({ requestHash: otcRequestHash(_request), nonce: 3 })
      return TX_HASH
    }),
    waitForTransactionReceipt: jest.fn(async () => ({
      transactionHash: TX_HASH,
      status: 'success' as const,
      blockNumber: 201n,
    })),
  }
}

describe.each(['canary', 'public'])('%s submission at the shared write sink', (mode) => {
  const canaryTest = mode === 'canary' ? it : it.skip
  beforeEach(() => {
    global.fetch = jest.fn(
      async (url) =>
        ({
          ok: true,
          json: async () => ({
            enabled: true,
            nonce: new URL(String(url), 'https://swap.ophis.fi').searchParams.get('nonce'),
          }),
        }) as Response,
    )
    jest.useFakeTimers({ now: Number(NOW) * 1_000 })
    process.env.REACT_APP_OTC_WRITE_MODE = mode
    auth.writeMode = mode
    policy.accounts = mode === 'public' ? [] : [MAKER]
    policy.pairs = mode === 'public' ? [] : [{ ...order, maxAmountA: order.amountA, maxAmountB: order.amountB }]
    policy.expiresAt = mode === 'public' ? 0n : NOW + 60n
  })
  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
    delete process.env.REACT_APP_OTC_WRITE_MODE
  })

  it.each(mode === 'canary' ? ['empty', 'cap', 'expiry', 'read flag', 'write flag'] : ['read flag', 'write flag'])(
    'blocks %s before any RPC or signature',
    async (reason) => {
      if (reason === 'empty') policy.accounts = []
      if (reason === 'cap')
        policy.pairs = [
          { tokenA: order.tokenA, tokenB: order.tokenB, maxAmountA: order.amountA - 1n, maxAmountB: order.amountB },
        ]
      if (reason === 'expiry') policy.expiresAt = NOW
      const authorization = { ...auth, readFlag: reason !== 'read flag', writeFlag: reason !== 'write flag' }
      const client = mockOtcWriteClient({ allowance: order.amountA })
      const read = jest.spyOn(client, 'getChainId')
      const submitter = wallet()
      await expect(submitOtcTransaction(client, submitter, intent, authorization, mockOtcManifest())).rejects.toThrow()
      expect(read).not.toHaveBeenCalled()
      expect(submitter.sendTransaction).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])('blocks runtime shutdown (after preflight: %s)', async (afterPreflight) => {
    const client = mockOtcWriteClient({ allowance: order.amountA })
    const pause = (): void => {
      global.fetch = jest.fn(async () => ({ ok: false }) as Response)
    }
    if (afterPreflight) jest.spyOn(client, 'simulate').mockImplementation(async () => pause())
    else pause()
    const read = jest.spyOn(client, 'getChainId')
    const submitter = wallet()
    await expect(submitOtcTransaction(client, submitter, intent, auth, mockOtcManifest())).rejects.toThrow(
      'writes are disabled',
    )
    if (!afterPreflight) expect(read).not.toHaveBeenCalled()
    expect(submitter.sendTransaction).not.toHaveBeenCalled()
  })

  it('executes the exact admitted intent only after preflight and a known receipt', async () => {
    const client = mockOtcWriteClient({ allowance: order.amountA })
    const simulated = jest.spyOn(client, 'simulate')
    const submitter = wallet()
    await expect(
      submitOtcTransaction(client, submitter, intent, auth, mockOtcManifest(), undefined, undefined, jest.fn()),
    ).resolves.toMatchObject({
      transactionHash: TX_HASH,
    })
    expect(simulated).toHaveBeenCalledTimes(1)
    expect(submitter.sendTransaction).toHaveBeenCalledTimes(1)
    expect(submitter.waitForTransactionReceipt).toHaveBeenCalledWith(TX_HASH, expect.objectContaining({ nonce: 3 }))
  })

  it('forwards the pre-prompt persistence callback through the shared sink', async () => {
    const onPrompt = jest.fn()
    await submitOtcTransaction(
      mockOtcWriteClient({ allowance: order.amountA }),
      wallet(),
      intent,
      auth,
      mockOtcManifest(),
      () => true,
      () => undefined,
      onPrompt,
    )
    expect(onPrompt).toHaveBeenCalledTimes(1)
  })

  it.each(['0x', '', null, 'not-a-hash'])(
    'rejects malformed returned hashes before upgrading a pre-prompt marker: %s',
    async (hash) => {
      const submitter = wallet()
      submitter.sendTransaction.mockImplementation(async (request, _intent, _time, _current, onPrompt) => {
        onPrompt?.({ requestHash: otcRequestHash(request), nonce: 3 })
        return hash as never
      })
      const onPrompt = jest.fn()
      const onBroadcast = jest.fn()
      await expect(
        submitOtcTransaction(
          mockOtcWriteClient({ allowance: order.amountA }),
          submitter,
          intent,
          auth,
          mockOtcManifest(),
          () => true,
          onBroadcast,
          onPrompt,
        ),
      ).rejects.toThrow('invalid transaction hash')
      expect(onPrompt).toHaveBeenCalledTimes(1)
      expect(onBroadcast).not.toHaveBeenCalled()
      expect(submitter.waitForTransactionReceipt).not.toHaveBeenCalled()
    },
  )

  it('preserves the broadcast hash as uncertain when the adapter skipped proof capture', async () => {
    const submitter = wallet()
    submitter.sendTransaction.mockResolvedValue(TX_HASH)
    const onBroadcast = jest.fn()
    await expect(
      submitOtcTransaction(
        mockOtcWriteClient({ allowance: order.amountA }),
        submitter,
        intent,
        auth,
        mockOtcManifest(),
        undefined,
        onBroadcast,
        jest.fn(),
      ),
    ).rejects.toMatchObject({ transactionHash: TX_HASH })
    expect(onBroadcast).toHaveBeenCalledWith(TX_HASH)
    expect(submitter.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid proof nonce %s before persistence',
    async (nonce) => {
      const submitter = wallet()
      submitter.sendTransaction.mockImplementation(async (request, _intent, _time, _current, onPrompt) => {
        onPrompt?.({ requestHash: otcRequestHash(request), nonce })
        return TX_HASH
      })
      const onPrompt = jest.fn()
      await expect(
        submitOtcTransaction(
          mockOtcWriteClient({ allowance: order.amountA }),
          submitter,
          intent,
          auth,
          mockOtcManifest(),
          undefined,
          undefined,
          onPrompt,
        ),
      ).rejects.toThrow('proof unavailable')
      expect(onPrompt).not.toHaveBeenCalled()
      expect(submitter.waitForTransactionReceipt).not.toHaveBeenCalled()
    },
  )

  canaryTest('rechecks expiration after simulation, before contacting the wallet', async () => {
    const client = mockOtcWriteClient({ allowance: order.amountA })
    client.simulate = async () => {
      jest.setSystemTime(Number(policy.expiresAt) * 1_000)
    }
    const submitter = wallet()
    await expect(submitOtcTransaction(client, submitter, intent, auth, mockOtcManifest())).rejects.toThrow('window')
    expect(submitter.sendTransaction).not.toHaveBeenCalled()
  })

  canaryTest('passes a live policy check to the adapter for its final post-RPC signature guard', async () => {
    const submitter = wallet()
    submitter.sendTransaction.mockImplementation(async (_request, _intent, _timestamp, current) => {
      jest.setSystemTime(Number(policy.expiresAt) * 1_000)
      current?.()
      return TX_HASH
    })
    await expect(
      submitOtcTransaction(
        mockOtcWriteClient({ allowance: order.amountA }),
        submitter,
        intent,
        auth,
        mockOtcManifest(),
      ),
    ).rejects.toThrow('window')
    expect(submitter.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it('keeps cancellation available after the entry window expires', async () => {
    policy.expiresAt = NOW
    policy.pairs = []
    await expect(
      submitOtcTransaction(
        mockOtcWriteClient(),
        wallet(),
        { kind: 'cancel', account: MAKER, order },
        auth,
        mockOtcManifest(),
        undefined,
        undefined,
        jest.fn(),
      ),
    ).resolves.toMatchObject({ status: 'success' })
  })
})
