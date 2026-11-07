import { beforeEach, expect, it, vi } from 'vitest'
import { ZeroAddress, ZeroHash, type TransactionReceipt } from 'ethers'
import { CONFIG, TOKENS } from './config'
import { PRIVACY } from './execution'
import type { WalletSession } from './wallet'
import { mixedWithdrawalData, mixedWithdrawalTransactions, withdrawalData } from '../tests/withdrawal.fixture'

const state = vi.hoisted(() => ({ value: undefined as unknown, preserved: undefined as unknown, remove: vi.fn(), history: vi.fn(), save: vi.fn() }))
vi.mock('./config', async (original) => ({ ...await original<typeof import('./config')>(),
  PILOT_WITHDRAWAL_RECIPIENT: '0x0000000000000000000000000000000000001234' }))
vi.mock('./storage', () => ({
  readPrivateState: async (_session: unknown, key: string) => key === 'preservedWithdrawal' ? state.preserved : state.value,
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
  resumePendingWithdrawal,
  canPreserveWethWithdrawal,
  preserveWethWithdrawal,
  restorePreservedWithdrawal,
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
    blockNumber: 102,
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
  state.preserved = undefined
  state.save.mockReset()
  state.remove.mockReset()
  state.history.mockResolvedValue([])
  call.mockResolvedValue(PRIVACY.encodeFunctionResult('nullifiers', [false]))
})

it('keeps the full unsupported WETH proof encrypted before releasing its active slot, and restores it without loss', async () => {
  const weth = { ...pending, token: 'WETH', transaction: { ...pending.transaction,
    data: withdrawalData(1, 1, pending.recipient, TOKENS.WETH.address) }, nullifiers: [`0x${'11'.repeat(32)}`] }
  state.value = weth
  state.save.mockImplementation(async (_session, key, value) => {
    if (key === 'preservedWithdrawal') state.preserved = value
    else state.value = value
  })
  state.remove.mockImplementation(async (_session, key) => {
    if (key === 'pendingWithdrawal') { expect(state.preserved).toEqual(weth); state.value = undefined }
    else state.preserved = undefined
  })
  expect(canPreserveWethWithdrawal(weth as PendingWithdrawal)).toBe(true)
  expect(canPreserveWethWithdrawal({ ...weth, transaction: { ...weth.transaction,
    data: withdrawalData(1, 1, pending.recipient, TOKENS.USDC.address) } } as PendingWithdrawal)).toBe(false)
  await expect(restorePreservedWithdrawal(session)).rejects.toThrow('Resolve the active withdrawal')
  state.remove.mockImplementationOnce(async () => { throw new Error('Interrupted active-record update') })
  await expect(preserveWethWithdrawal(session)).rejects.toThrow('Interrupted active-record update')
  expect(state.value).toEqual(weth)
  expect(state.preserved).toEqual(weth)
  await preserveWethWithdrawal(session)
  expect(state.value).toBeUndefined()
  expect(state.preserved).toEqual(weth)
  await restorePreservedWithdrawal(session)
  expect(state.value).toEqual({ ...weth, chainId: 1 })
  expect(state.preserved).toBeUndefined()
})

it('never releases a proof when preservation fails, a hash exists, inputs are spent, or another proof is preserved', async () => {
  const weth = { ...pending, token: 'WETH', transaction: { ...pending.transaction,
    data: withdrawalData(1, 1, pending.recipient, TOKENS.WETH.address) }, nullifiers: [`0x${'11'.repeat(32)}`] }
  state.value = weth
  state.save.mockRejectedValueOnce(new Error('Storage failure'))
  await expect(preserveWethWithdrawal(session)).rejects.toThrow('Storage failure')
  expect(state.remove).not.toHaveBeenCalled()
  state.value = { ...weth, hash: `0x${'33'.repeat(32)}` }
  await expect(preserveWethWithdrawal(session)).rejects.toThrow('without a transaction hash')
  state.value = weth
  call.mockResolvedValueOnce(PRIVACY.encodeFunctionResult('nullifiers', [true]))
  await expect(preserveWethWithdrawal(session)).rejects.toThrow('input is spent')
  state.preserved = { ...weth, transaction: { ...weth.transaction, data: withdrawalData(1, 1, pending.recipient, TOKENS.USDC.address) } }
  await expect(preserveWethWithdrawal(session)).rejects.toThrow('Another preserved withdrawal exists')
  expect(state.remove).not.toHaveBeenCalled()
})

it('retains unknown withdrawals and rejects damaged encrypted records', async () => {
  await expect(reconcilePendingWithdrawal(session)).rejects.toThrow(/not confirmed/)
  await expect(reconcilePendingWithdrawal(session)).rejects.toThrow('Saved withdrawal: 0.001 USDC')
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
    expect(() => assertWithdrawalReceipt(receipt(), invalid)).toThrow(/not confirmed|does not match/)
  }
  expect(() => assertWithdrawalReceipt({ ...receipt(), status: 0 } as TransactionReceipt, pending)).toThrow(/reverted/)
})

it.each(['wrong-tree', 'older-block'])('rejects a withdrawal receipt with %s even when nullifier bytes and output match', (reason) => {
  const actual = receipt()
  const modified = reason === 'wrong-tree'
    ? { ...actual, logs: [actual.logs[0], { address: CONFIG.proxyContract, ...PRIVACY.encodeEventLog('Nullified', [1, [nullifier]]) }] }
    : { ...actual, blockNumber: 99 }
  expect(() => assertWithdrawalReceipt(modified as unknown as TransactionReceipt, pending)).toThrow(/not confirmed/)
})

it('preserves an older separable-fee proof and blocks public rebroadcast before contacting a signer', async () => {
  state.value = { ...pending, transaction: { ...pending.transaction, data: withdrawalData(2) } }
  const signer = { sendTransaction: vi.fn(), getAddress: vi.fn() }
  await expect(resumePendingWithdrawal(session, signer as unknown as Parameters<typeof resumePendingWithdrawal>[1]))
    .rejects.toThrow(/must share one proof/)
  expect(signer.sendTransaction).not.toHaveBeenCalled()
  expect(signer.getAddress).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled()
  expect(state.save).not.toHaveBeenCalled()
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

it('preserves both original proofs when only the independent legacy fee input is spent', async () => {
  const legacy = mixedWithdrawalData(TOKENS.USDC.address, pending.recipient)
  state.value = { ...pending, nullifiers: [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`], transaction: { ...pending.transaction, data: legacy } }
  call.mockResolvedValueOnce(PRIVACY.encodeFunctionResult('nullifiers', [true]))
    .mockResolvedValueOnce(PRIVACY.encodeFunctionResult('nullifiers', [false]))
  await expect(reconcilePendingWithdrawal(session)).rejects.toThrow('Remaining principal proofs must be recovered before clearing')
  expect(state.remove).not.toHaveBeenCalled()
  expect(state.save).not.toHaveBeenCalled()
  expect((state.value as PendingWithdrawal).transaction.data).toBe(legacy)
})

it('keeps the original single-proof invariant when one of its multiple inputs is spent', async () => {
  const tx = PRIVACY.decodeFunctionData('transact', pending.transaction.data)[0][0]
  const extra = `0x${'55'.repeat(32)}`
  const transaction = { proof: tx.proof, merkleRoot: tx.merkleRoot, nullifiers: [nullifier, extra],
    boundParams: tx.boundParams, commitments: tx.commitments, unshieldPreimage: tx.unshieldPreimage }
  state.value = { ...pending, nullifiers: [nullifier, extra], transaction: { ...pending.transaction,
    data: PRIVACY.encodeFunctionData('transact', [[transaction]]) } }
  call.mockResolvedValueOnce(PRIVACY.encodeFunctionResult('nullifiers', [true]))
    .mockResolvedValueOnce(PRIVACY.encodeFunctionResult('nullifiers', [false]))
  await expect(reconcilePendingWithdrawal(session)).resolves.toContain('no longer executable')
  expect(state.remove).toHaveBeenCalledOnce()
})

it('clears a legacy mixed record only when every proof has an invalidating spent input', async () => {
  const txs = mixedWithdrawalTransactions(TOKENS.USDC.address, pending.recipient)
  txs[0].nullifiers.push(`0x${'44'.repeat(32)}`);txs[1].nullifiers.push(`0x${'55'.repeat(32)}`)
  state.value = { ...pending, nullifiers: txs.flatMap((tx) => tx.nullifiers), transaction: { ...pending.transaction,
    data: PRIVACY.encodeFunctionData('transact', [txs]) } }
  for (const flag of [true, false, true, false]) call.mockResolvedValueOnce(PRIVACY.encodeFunctionResult('nullifiers', [flag]))
  await expect(reconcilePendingWithdrawal(session)).resolves.toContain('no longer executable')
  expect(state.remove).toHaveBeenCalledOnce()
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
