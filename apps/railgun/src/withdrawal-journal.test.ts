import { beforeEach, expect, it, vi } from 'vitest'
import { ZeroAddress, ZeroHash, type TransactionReceipt } from 'ethers'
import { CONFIG, TOKENS } from './config'
import { PRIVACY } from './execution'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ value: undefined as unknown, remove: vi.fn(), history: vi.fn(), save: vi.fn() }))
vi.mock('./storage', () => ({
  readPrivateState: async () => state.value,
  writePrivateState: state.save,
  deletePrivateState: state.remove,
}))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...(await original<typeof import('@railgun-community/wallet')>()),
  getWalletTransactionHistory: state.history,
}))
import {
  assertWithdrawalReceipt,
  pendingWithdrawal,
  reconcilePendingWithdrawal,
  type PendingWithdrawal,
} from './withdrawal-journal'
import { assertWithdrawalRecipient } from './unshield'

const nullifier = `0x${'22'.repeat(32)}`
const data = PRIVACY.encodeFunctionData('transact', [
  [
    {
      proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
      merkleRoot: ZeroHash,
      nullifiers: [nullifier],
      commitments: [],
      boundParams: {
        treeNumber: 0,
        minGasPrice: 0,
        unshield: 1,
        chainID: 1,
        adaptContract: ZeroAddress,
        adaptParams: ZeroHash,
        commitmentCiphertext: [],
      },
      unshieldPreimage: {
        npk: ZeroHash,
        token: { tokenAddress: TOKENS.USDC.address, tokenType: 0, tokenSubID: 0 },
        value: 1000,
      },
    },
  ],
])
const pending: PendingWithdrawal = {
  token: 'USDC',
  recipient: '0x0000000000000000000000000000000000001234',
  minimum: '997',
  fromBlock: 100,
  nullifiers: [nullifier],
  transaction: { to: CONFIG.proxyContract, data, value: '0' },
  minGasPrice: '1',
}
const getReceipt = vi.fn()
const call = vi.fn()
const session = {
  info: { id: 'test-wallet' },
  provider: { getTransactionReceipt: getReceipt, getBlockNumber: async () => 102, call },
} as unknown as WalletSession

function receipt(): TransactionReceipt {
  const unshield = PRIVACY.getEvent('Unshield')
  const nullified = PRIVACY.getEvent('Nullified')
  if (!unshield || !nullified) throw new Error('Missing Railgun events')
  return {
    status: 1,
    confirmations: async () => 2,
    logs: [
      {
        address: CONFIG.proxyContract,
        ...PRIVACY.encodeEventLog(unshield, [
          pending.recipient,
          { tokenAddress: TOKENS.USDC.address, tokenType: 0, tokenSubID: 0 },
          997,
          3,
        ]),
      },
      { address: CONFIG.proxyContract, ...PRIVACY.encodeEventLog(nullified, [0, [nullifier]]) },
    ],
  } as unknown as TransactionReceipt
}

beforeEach(() => {
  vi.clearAllMocks()
  state.value = pending
  state.history.mockResolvedValue([])
  call.mockResolvedValue(PRIVACY.encodeFunctionResult('nullifiers', [false]))
})

it('retains unknown withdrawals and rejects damaged encrypted records', async () => {
  await expect(reconcilePendingWithdrawal(session)).rejects.toThrow(/not confirmed/)
  expect(state.remove).not.toHaveBeenCalled()
  state.value = { ...pending, transaction: { ...pending.transaction, to: TOKENS.USDC.address } }
  await expect(pendingWithdrawal(session)).rejects.toThrow(/damaged/)
})

it('requires the saved nullifiers, correct token, recipient and minimum output', () => {
  expect(() => assertWithdrawalReceipt(receipt(), pending)).not.toThrow()
  for (const invalid of [
    { ...pending, nullifiers: [`0x${'33'.repeat(32)}`] },
    { ...pending, minimum: '998' },
    { ...pending, token: 'WETH' as const },
    { ...pending, recipient: TOKENS.WETH.address },
  ]) {
    expect(() => assertWithdrawalReceipt(receipt(), invalid)).toThrow(/not confirmed/)
  }
  expect(() => assertWithdrawalReceipt({ ...receipt(), status: 0 } as TransactionReceipt, pending)).toThrow(/reverted/)
})

it('recovers a lost response hash from wallet history before clearing', async () => {
  state.history.mockResolvedValue([
    { txid: '44'.repeat(32), unshieldERC20Amounts: [{ recipientAddress: pending.recipient }] },
  ])
  getReceipt.mockResolvedValue(receipt())
  await expect(reconcilePendingWithdrawal(session)).resolves.toMatch(/confirmed/)
  expect(getReceipt).toHaveBeenCalledWith(`0x${'44'.repeat(32)}`)
  expect(state.remove).toHaveBeenCalledOnce()
})

it('finds the successful original withdrawal when its duplicate resubmission reverts', async () => {
  const duplicate = `0x${'55'.repeat(32)}`
  state.value = { ...pending, hash: duplicate }
  state.history.mockResolvedValue([
    { txid: '44'.repeat(32), unshieldERC20Amounts: [{ recipientAddress: pending.recipient }] },
  ])
  getReceipt.mockImplementation(async (hash: string) => (hash === duplicate ? { ...receipt(), status: 0 } : receipt()))
  await expect(reconcilePendingWithdrawal(session)).resolves.toContain(`0x${'44'.repeat(32)}`)
  expect(state.remove).toHaveBeenCalledOnce()
})

it('can dismiss a proof only after a saved input is spent at a confirmed block', async () => {
  call.mockResolvedValue(PRIVACY.encodeFunctionResult('nullifiers', [true]))
  await expect(reconcilePendingWithdrawal(session)).resolves.toMatch(/no longer executable/)
  expect(state.remove).toHaveBeenCalledOnce()
  expect(call.mock.calls[0][0].blockTag).toBe(101)
})

it('rejects protocol contracts and the temporary account as withdrawal recipients', () => {
  for (const address of [
    '0x0000000000000000000000000000000000000000',
    TOKENS.USDC.address,
    TOKENS.WETH.address,
    CONFIG.proxyContract,
    pending.recipient,
  ])
    expect(() => assertWithdrawalRecipient(address, pending.recipient)).toThrow(/recipient wallet/)
  expect(() => assertWithdrawalRecipient('0x0000000000000000000000000000000000005678', pending.recipient)).not.toThrow()
})
