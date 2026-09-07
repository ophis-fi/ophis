import { buildOtcCancelTransaction } from './buildOtcTransaction'
import { otcRequestHash, readOtcSubmissionProof, verifyOtcTransactionProof } from './otcTransactionProof'
import { MAKER, mockOtcOrder, TX_HASH } from './prepareOtcTransactionTest.utils'

import type { PublicClient } from 'viem'

const request = buildOtcCancelTransaction({ kind: 'cancel', account: MAKER, order: mockOtcOrder() })
const proof = { requestHash: otcRequestHash(request), nonce: 5 }
const transaction = { hash: TX_HASH, from: MAKER, to: request.to, input: request.data, value: 0n, nonce: 5 }

it('captures the independently read nonce for the signer and exact reviewed calldata', async () => {
  const getTransactionCount = jest.fn(async () => 5)
  const client = { getTransactionCount } as unknown as PublicClient
  await expect(readOtcSubmissionProof(client, request)).resolves.toEqual(proof)
  expect(getTransactionCount).toHaveBeenCalledWith({ address: MAKER, blockTag: 'pending' })
  await expect(
    verifyOtcTransactionProof({ getTransaction: async () => transaction } as never, TX_HASH, proof),
  ).resolves.toBeUndefined()
})

it.each([
  { nonce: 4 },
  { nonce: 6 },
  { nonce: NaN },
  { nonce: Infinity },
  { nonce: 1.5 },
  { from: '0x1111111111111111111111111111111111111111' },
  { to: '0x1111111111111111111111111111111111111111' },
  { to: null },
  { input: '0x' },
  { value: 1n },
  { hash: `0x${'cc'.repeat(32)}` },
])('rejects stale or unrelated mined transactions: %s', async (changed) => {
  const client = { getTransaction: async () => ({ ...transaction, ...changed }) } as unknown as PublicClient
  await expect(verifyOtcTransactionProof(client, TX_HASH, proof)).rejects.toThrow('differs from reviewed intent')
})

it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects an invalid nonce %s before signing',
  async (nonce) => {
    const client = { getTransactionCount: async () => nonce } as unknown as PublicClient
    await expect(readOtcSubmissionProof(client, request)).rejects.toThrow('nonce unavailable')
  },
)

it('bounds both nonce and post-receipt transaction reads', async () => {
  jest.useFakeTimers()
  try {
    const stalled = (): Promise<never> => new Promise<never>(() => undefined)
    const client = { getTransactionCount: stalled, getTransaction: stalled } as unknown as PublicClient
    const nonce = expect(readOtcSubmissionProof(client, request)).rejects.toThrow('nonce read timed out')
    const receipt = expect(verifyOtcTransactionProof(client, TX_HASH, proof)).rejects.toThrow('verification timed out')
    await jest.advanceTimersByTimeAsync(8_000)
    await Promise.all([nonce, receipt])
  } finally {
    jest.useRealTimers()
  }
})
