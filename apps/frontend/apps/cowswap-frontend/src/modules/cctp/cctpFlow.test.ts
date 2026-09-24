import { type Hex, type WalletClient } from 'viem'

import { cctpBurnData, cctpClient, circleGet, type CctpTransfer } from './cctp.service'
import { CCTP_STORAGE_KEY, cctpStorage, cctpTransferSchema } from './cctpState'
import * as cctpStatus from './cctpStatus.service'
import { getCctpStatus } from './cctpStatus.service'
import { claimCctpTransfer, resumeCctpTransfer, submitCctpBurn, updateCctpTransfer } from './cctpSubmission.service'
import { burnCctp, claimCctp } from './cctpWallet.service'

jest.mock('./cctpWallet.service', () => ({ burnCctp: jest.fn(), claimCctp: jest.fn() }))
jest.mock('./cctp.service', () => ({
  ...jest.requireActual('./cctp.service'),
  cctpClient: jest.fn(),
  circleGet: jest.fn(),
}))
const owner = '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A'
const transfer: CctpTransfer = {
  source: 8453,
  destination: 5042,
  owner,
  amount: '2000000',
  maxFee: '15638',
  quotedAt: 1000,
  sourceNonce: 7,
}
const hash: Hex = `0x${'ab'.repeat(32)}`
const wallet = {} as WalletClient
const persist = (value: CctpTransfer | null): void => cctpStorage.setItem(CCTP_STORAGE_KEY, value)
const burn = jest.mocked(burnCctp)

beforeEach(() => {
  jest.resetAllMocks()
  persist(null)
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: jest.fn(async (_name: string, _options: unknown, action: (lock: object) => Promise<void>) => action({})),
    },
  })
})

it('journals before signing, retains uncertain broadcasts and blocks another burn after reload', async () => {
  burn.mockImplementation(async (_wallet, quote, beforeSignature) => {
    await beforeSignature(7)
    expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual(quote)
    throw new Error('Wallet connection lost after broadcast')
  })
  await expect(submitCctpBurn(wallet, transfer, persist)).rejects.toThrow('connection lost')
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual(transfer)
  await expect(submitCctpBurn(wallet, transfer, persist)).rejects.toThrow('already pending')
  expect(burn).toHaveBeenCalledTimes(1)
})

it('clears only explicit rejection, preserves ambiguous rejection text and saves a returned hash', async () => {
  burn.mockImplementationOnce(async (_wallet, _quote, beforeSignature) => {
    await beforeSignature(7)
    throw { code: 4001 }
  })
  await expect(submitCctpBurn(wallet, transfer, persist)).rejects.toEqual({ code: 4001 })
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toBeNull()
  burn.mockImplementationOnce(async (_wallet, _quote, beforeSignature) => {
    await beforeSignature(7)
    throw new Error('request rejected by upstream after broadcast')
  })
  await expect(submitCctpBurn(wallet, transfer, persist)).rejects.toThrow('upstream')
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual(transfer)
  persist(null)
  burn.mockImplementationOnce(async (_wallet, _quote, beforeSignature) => {
    await beforeSignature(7)
    return hash
  })
  await submitCctpBurn(wallet, transfer, persist)
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual({ ...transfer, burnHash: hash })
})

it('does not reach wallet signing if storage or the cross-tab lock is unavailable', async () => {
  const send = jest.fn()
  burn.mockImplementation(async (_wallet, _quote, beforeSignature) => {
    await beforeSignature(7)
    send()
    return hash
  })
  await expect(submitCctpBurn(wallet, transfer, () => undefined)).rejects.toThrow('Unable to save')
  expect(send).not.toHaveBeenCalled()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
  await expect(submitCctpBurn(wallet, transfer, persist)).rejects.toThrow('current browser')
  expect(burn).toHaveBeenCalledTimes(1)
})

it('refuses an unrelated reverted hash as recovery proof and accepts only exact burn calldata', async () => {
  const client = {
    getTransactionReceipt: jest.fn().mockResolvedValue({ status: 'reverted', blockNumber: 1n }),
    getBlock: jest.fn().mockResolvedValue({ number: 2n }),
    getTransaction: jest.fn().mockResolvedValue({ from: owner, to: owner, input: '0x1234', value: 0n, nonce: 7 }),
  }
  jest.mocked(cctpClient).mockReturnValue(client as unknown as ReturnType<typeof cctpClient>)
  await expect(resumeCctpTransfer(transfer, hash)).rejects.toThrow('does not match')
  client.getTransaction.mockResolvedValue({
    from: owner,
    to: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    input: cctpBurnData(transfer),
    value: 0n,
    nonce: 7,
  })
  expect((await getCctpStatus({ ...transfer, burnHash: hash })).failed).toBe(true)
  expect(circleGet).not.toHaveBeenCalled()
  client.getTransaction.mockResolvedValue({
    from: owner,
    to: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    input: cctpBurnData(transfer),
    value: 0n,
    nonce: 6,
  })
  await expect(resumeCctpTransfer(transfer, hash)).rejects.toThrow('does not match')
})

it('does not treat pending or malformed Circle data as received USDC', async () => {
  jest.mocked(circleGet).mockResolvedValueOnce(null)
  expect((await getCctpStatus({ ...transfer, burnHash: hash }, true)).completed).toBe(false)
  jest.mocked(circleGet).mockResolvedValueOnce({ messages: [{ message: '0x', attestation: 'PENDING' }] })
  expect((await getCctpStatus({ ...transfer, burnHash: hash }, true)).completed).toBe(false)
  jest.mocked(circleGet).mockResolvedValueOnce({ sourceTxHash: `0x${'cd'.repeat(32)}`, messages: [] })
  await expect(getCctpStatus({ ...transfer, burnHash: hash }, true)).rejects.toThrow('different source')
})

it('serializes recovery with burns and prevents a stale tab from clearing a newer transfer', async () => {
  let locked = false
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, action: (lock: object | null) => Promise<void>) => {
        if (locked) return action(null)
        locked = true
        try {
          await action({})
        } finally {
          locked = false
        }
      },
    },
  })
  persist(transfer)
  let release: (value: CctpTransfer) => void = () => undefined
  const delayed = new Promise<CctpTransfer>((resolve) => {
    release = resolve
  })
  const recovering = updateCctpTransfer(transfer, () => delayed, persist)
  await expect(updateCctpTransfer(transfer, async () => null, persist)).rejects.toThrow('Another tab')
  await expect(submitCctpBurn(wallet, transfer, persist)).rejects.toThrow('already pending')
  expect(burn).not.toHaveBeenCalled()
  const resumed = { ...transfer, burnHash: hash }
  release(resumed)
  await recovering
  await expect(updateCctpTransfer(transfer, async () => null, persist)).rejects.toThrow('changed in another tab')
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual(resumed)
  await updateCctpTransfer(resumed, async () => null, persist)
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toBeNull()
})

it('journals a claim before signing and retains it after a lost wallet response', async () => {
  const status = jest.spyOn(cctpStatus, 'getCctpStatus').mockResolvedValue({
    text: 'ready',
    mintHash: hash,
    claimPending: false,
    completed: false,
    failed: false,
    sourceConfirmed: true,
    message: '0x01',
    attestation: '0x02',
  })
  const saved = { ...transfer, burnHash: hash }
  persist(saved)
  jest.mocked(claimCctp).mockImplementationOnce(async (_wallet, _quote, _message, _attestation, beforeSignature) => {
    await beforeSignature(9)
    expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual({ ...saved, claimNonce: 9 })
    throw new Error('wallet disconnected after broadcast')
  })
  try {
    await expect(claimCctpTransfer(wallet, saved, persist)).rejects.toThrow('after broadcast')
    expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual({ ...saved, claimNonce: 9 })
    status.mockResolvedValueOnce({
      text: 'pending',
      completed: false,
      failed: false,
      sourceConfirmed: true,
      claimPending: true,
    })
    await expect(claimCctpTransfer(wallet, { ...saved, claimNonce: 9 }, persist)).rejects.toThrow('already pending')
    expect(claimCctp).toHaveBeenCalledTimes(1)
  } finally {
    status.mockRestore()
  }
})

it('accepts only a finalized self-send at the saved source nonce as wallet cancellation', async () => {
  const client = {
    getTransactionReceipt: jest.fn().mockResolvedValue({ status: 'success', blockNumber: 500n, blockHash: hash }),
    getTransaction: jest.fn().mockResolvedValue({ from: owner, to: owner, input: '0x', value: 0n, nonce: 7 }),
    getBlock: jest.fn().mockResolvedValue({ number: 600n, hash }),
  }
  jest.mocked(cctpClient).mockReturnValue(client as unknown as ReturnType<typeof cctpClient>)
  const cancelled = { ...transfer, burnHash: hash }
  client.getBlock.mockResolvedValueOnce({ number: 499n, hash })
  expect((await getCctpStatus(cancelled)).failed).toBe(false)
  expect((await getCctpStatus(cancelled)).failed).toBe(true)
  client.getTransaction.mockResolvedValueOnce({ from: owner, to: owner, input: '0x', value: 0n, nonce: 6 })
  await expect(getCctpStatus(cancelled)).rejects.toThrow('does not match')
  expect(circleGet).not.toHaveBeenCalled()
})

it('matches the journal after reload, schema parsing and appending a recovered claim hash', async () => {
  persist({ ...transfer, burnHash: hash, claimNonce: 9 })
  const reloaded = cctpTransferSchema.parse(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))
  await updateCctpTransfer(reloaded, async () => ({ ...reloaded, mintHash: hash }), persist)
  const parsed = cctpTransferSchema.parse(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))
  await updateCctpTransfer(parsed, async () => null, persist)
  expect(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toBeNull()
})
