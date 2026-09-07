import { buildOtcCancelTransaction } from './buildOtcTransaction'
import { OTC_CANARY_POLICY } from './otcCanary.const'
import { otcRequestHash } from './otcTransactionProof'
import { toOtcForkClients, toOtcLegacyForkClients, toOtcWalletSubmitter } from './otcWriteAdapters'
import { MAKER, mockOtcOrder, NOW, TX_HASH } from './prepareOtcTransactionTest.utils'

import type { OtcWalletSubmitter, OtcWriteClient } from './otcWrite.types'

type Public = Parameters<typeof toOtcWalletSubmitter>[1]
type Wallet = Parameters<typeof toOtcWalletSubmitter>[0]
type Legacy = Parameters<typeof toOtcLegacyForkClients>[0]

jest.mock('./otcCanary.const', () => ({ OTC_CANARY_POLICY: { accounts: [], pairs: [], expiresAt: 0n } }))
const HEAD = { number: 200n, hash: `0x${'bb'.repeat(32)}` as const, timestamp: NOW }
const INTENT = { kind: 'cancel' as const, account: MAKER, order: mockOtcOrder() }
const REQUEST = buildOtcCancelTransaction(INTENT)
const PROOF = { requestHash: otcRequestHash(REQUEST), nonce: 3 }

function canonicalClient(): Public {
  return {
    getChainId: jest.fn(async () => 1),
    getTransactionCount: jest.fn(async () => 3),
    getTransaction: jest.fn(async () => ({
      hash: TX_HASH,
      from: MAKER,
      to: REQUEST.to,
      input: REQUEST.data,
      value: 0n,
      nonce: 3,
    })),
    getBlock: jest.fn(async () => HEAD),
    call: jest.fn(async () => ({ data: '0x' })),
    waitForTransactionReceipt: jest.fn(async () => ({
      transactionHash: TX_HASH,
      status: 'success',
      blockNumber: 201n,
    })),
  } as unknown as Public
}

function fixture(legacy: boolean): {
  connected: Public
  canonical: Public
  submitter: OtcWalletSubmitter
  writeClient: OtcWriteClient
  send: jest.Mock
} {
  const connected = canonicalClient()
  const canonical = canonicalClient()
  const send = jest.fn(async () => (legacy ? { hash: TX_HASH } : TX_HASH))
  if (!legacy) {
    const wallet = {
      account: { address: MAKER },
      getChainId: () => connected.getChainId(),
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_accounts') return [MAKER]
        throw new Error(`Unexpected fork RPC: ${method}`)
      },
      sendTransaction: send,
      extend: () => connected,
    } as unknown as Wallet
    const clients = toOtcForkClients(wallet, undefined, canonical)
    return { connected, canonical, send, submitter: clients.wallet, writeClient: clients.writeClient }
  }
  const provider = {
    getNetwork: async () => ({ chainId: await connected.getChainId() }),
    getBlock: () => connected.getBlock(),
    listAccounts: async () => [MAKER],
    getSigner: () => ({ sendTransaction: send }),
    waitForTransaction: connected.waitForTransactionReceipt,
  } as unknown as Legacy
  const clients = toOtcLegacyForkClients(provider, MAKER, undefined, canonical)
  return { connected, canonical, send, submitter: clients.wallet, writeClient: clients.writeClient }
}

describe.each([false, true])('canonical canary adapter (legacy=%s)', (legacy) => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Number(NOW) * 1_000 })
    Object.assign(OTC_CANARY_POLICY, { accounts: [MAKER] })
  })
  afterEach(() => jest.useRealTimers())

  it('submits on matching Ethereum state and obtains confirmation only from the independent reader', async () => {
    const { connected, canonical, send, submitter } = fixture(legacy)
    await expect(submitter.sendTransaction(REQUEST, INTENT, NOW)).resolves.toBe(TX_HASH)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ nonce: PROOF.nonce }))
    await expect(submitter.waitForTransactionReceipt(TX_HASH, PROOF)).resolves.toMatchObject({
      transactionHash: TX_HASH,
    })
    expect(canonical.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: TX_HASH, timeout: 120_000 }),
    )
    expect(connected.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it('reads settlement terms and simulates through the independent reader, never the wallet RPC', async () => {
    const { canonical, connected, writeClient } = fixture(legacy)
    await writeClient.call({ to: REQUEST.to, data: REQUEST.data, blockNumber: HEAD.number })
    await writeClient.simulate(REQUEST, HEAD.number)
    expect(canonical.call).toHaveBeenCalledTimes(2)
    expect(canonical.call).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: MAKER, blockNumber: HEAD.number }),
    )
    expect(connected.call).not.toHaveBeenCalled()
  })

  it('rejects divergent wallet state before signing, even when the chain ID is one', async () => {
    const { connected, send, submitter } = fixture(legacy)
    jest.mocked(connected.getBlock).mockResolvedValue({ ...HEAD, hash: `0x${'cc'.repeat(32)}` } as never)
    await expect(submitter.sendTransaction(REQUEST, INTENT, NOW)).rejects.toThrow('does not match')
    expect(send).not.toHaveBeenCalled()
  })

  it('fails closed when canonical confirmation is unavailable instead of trusting a wallet-fork receipt', async () => {
    const { canonical, connected, submitter } = fixture(legacy)
    jest.mocked(canonical.waitForTransactionReceipt).mockRejectedValue(new Error('canonical receipt unavailable'))
    await expect(submitter.waitForTransactionReceipt(TX_HASH, PROOF)).rejects.toThrow('canonical receipt unavailable')
    expect(connected.waitForTransactionReceipt).not.toHaveBeenCalled()
  })

  it('rechecks live authorization after its asynchronous network checks', async () => {
    const { send, submitter } = fixture(legacy)
    await expect(submitter.sendTransaction(REQUEST, INTENT, NOW, () => false)).rejects.toThrow('context changed')
    expect(send).not.toHaveBeenCalled()
  })

  it('aborts before either signer when the durable pre-prompt marker cannot be stored', async () => {
    const { send, submitter } = fixture(legacy)
    await expect(
      submitter.sendTransaction(
        REQUEST,
        INTENT,
        NOW,
        () => true,
        () => {
          throw new Error('storage unavailable')
        },
      ),
    ).rejects.toThrow('storage unavailable')
    expect(send).not.toHaveBeenCalled()
  })

  it('enforces wallet admission at the signing boundary even for cancellations', async () => {
    Object.assign(OTC_CANARY_POLICY, { accounts: [] })
    const { send, submitter } = fixture(legacy)
    await expect(submitter.sendTransaction(REQUEST, INTENT, NOW)).rejects.toThrow('not in the OTC canary')
    expect(send).not.toHaveBeenCalled()
  })
})
