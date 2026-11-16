import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG, TOKENS, registerToken, ROUTE_INTERMEDIATES } from './config'
import { ADAPT, PRIVACY } from './execution'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ record: undefined as unknown, ratchet: vi.fn(), remove: vi.fn(), history: vi.fn(), sync: vi.fn(), base: false,
  finalized: 125, reorg: false, chainId: 1 }))
vi.mock('./config', async original => ({ ...await original<typeof import('./config')>(), get CHAIN_ID() { return state.base ? 8453 : state.chainId } }))
vi.mock('./wallet', () => ({ syncWallet: state.sync }))
vi.mock('./storage', () => ({
  readPrivateState: async () => state.record,
  writePrivateState: async (_session: unknown, _key: string, value: unknown) => {
    state.record = value
  },
  deletePrivateState: async () => {
    state.remove()
  },
}))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...(await original<typeof import('@railgun-community/wallet')>()),
  fullWalletForID: () => ({ setEphemeralKeyIndexIfGreater: state.ratchet }),
  getWalletTransactionHistory: state.history,
}))
import { pendingSwap, reconcilePendingSwap, savePendingSwap, type PendingSwap } from './journal'

const npk = `0x${'01'.padStart(64, '0')}`
const nullifier = `0x${'33'.repeat(32)}`
const spent = { address: CONFIG.proxyContract, ...PRIVACY.encodeEventLog('Nullified', [0, [nullifier]]) }
const pending: PendingSwap = {
  index: 3,
  account: '0x0000000000000000000000000000000000001234',
  token: 'WETH',
  minimum: '10',
  npk,
  hash: `0x${'11'.repeat(32)}`,
  executeNonce: '0',
  fromBlock: 123,
  inputs: [{ tree: 0, nullifier }],
}
const receipt = vi.fn()
const balance = vi.fn()
const session = {
  info: { id: 'test-wallet' },
  accounts: { getAccount: async () => ({ address: pending.account }) },
  provider: { getTransactionReceipt: receipt, call: balance, getNetwork: async () => ({ chainId: 8453n }),
    send: async (method: string, params: unknown[]) => {
      expect(method).toBe('eth_getBlockByNumber'); expect(params[1]).toBe(false)
      const block = await session.provider.getBlock(params[0] === 'finalized' ? 'finalized' : Number(BigInt(String(params[0]))))
      return { ...block, number: `0x${block!.number.toString(16)}` }
    },
    getBlock: async (tag: string | number) => ({ number: tag === 'finalized' ? state.finalized : tag,
      hash: `0x${(state.reorg && tag === 125 ? '55' : '44').repeat(32)}` }) },
} as unknown as WalletSession

beforeEach(() => {
  state.record = undefined
  state.base = false
  state.chainId = 1
  state.finalized = 125; state.reorg = false
  vi.clearAllMocks()
  state.history.mockResolvedValue([])
  balance.mockResolvedValue(`0x${'00'.repeat(32)}`)
})

describe('pending swap recovery journal', () => {
  it.each([1, 56, 42161, 137])('retains an orphaned cached swap receipt and account index on chain %i', async chainId => {
    state.chainId = chainId; state.record = { ...pending, chainId }
    const output = PRIVACY.encodeEventLog('Shield', [0, 0,
      [{ npk, token: { tokenAddress: TOKENS.WETH.address, tokenType: 0, tokenSubID: 0 }, value: 10n }], [], []])
    const mined = { hash: pending.hash, blockHash: `0x${'44'.repeat(32)}`, blockNumber: 125, status: 1,
      confirmations: async () => 10, logs: [spent, { address: CONFIG.proxyContract, ...output }] } as never
    state.reorg = true
    await expect(reconcilePendingSwap(session, false, false, mined)).rejects.toThrow('history changed')
    expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
    expect(state.record).toEqual({ ...pending, chainId }); expect(receipt).not.toHaveBeenCalled()
    state.reorg = false
    await expect(reconcilePendingSwap(session, false, false, mined)).resolves.toContain('Private output confirmed')
    expect(state.remove).toHaveBeenCalledOnce(); expect(state.ratchet).toHaveBeenCalledOnce()
  })
  it('retains a synchronized Base swap through inclusion and reorg until canonical finality', async () => {
    state.base = true; state.finalized = 124
    state.record = { ...pending, chainId: 8453 }
    const output = PRIVACY.encodeEventLog('Shield', [0, 0,
      [{ npk, token: { tokenAddress: TOKENS.WETH.address, tokenType: 0, tokenSubID: 0 }, value: 10n }], [], []])
    const mined = { hash: pending.hash, blockHash: `0x${'44'.repeat(32)}`, blockNumber: 125, status: 1,
      confirmations: async () => 2, logs: [spent, { address: CONFIG.proxyContract, ...output }] } as never
    state.sync.mockResolvedValue(undefined)
    await expect(reconcilePendingSwap(session, false, false, mined)).rejects.toThrow('included; awaiting Base finality')
    expect(state.sync).toHaveBeenCalledWith(session, mined)
    expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
    state.finalized = 125; state.reorg = true
    await expect(reconcilePendingSwap(session, false, false, mined)).rejects.toThrow('history changed')
    expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
    state.reorg = false
    await expect(reconcilePendingSwap(session, false, false, mined)).resolves.toContain('Private output confirmed')
    expect(state.remove).toHaveBeenCalledOnce(); expect(state.ratchet).toHaveBeenCalledOnce()
  })
  it('preserves the Base recovery record until existing-receipt history coverage succeeds', async () => {
    state.base = true
    state.record = { ...pending, chainId: 8453 }
    const output = PRIVACY.encodeEventLog('Shield', [0, 0,
      [{ npk, token: { tokenAddress: TOKENS.WETH.address, tokenType: 0, tokenSubID: 0 }, value: 10n }], [], []])
    const mined = { hash: pending.hash, blockHash: `0x${'44'.repeat(32)}`, blockNumber: 125, status: 1,
      confirmations: async () => 2, logs: [spent, { address: CONFIG.proxyContract, ...output }] } as never
    state.sync.mockRejectedValueOnce(new Error('history catching up')).mockResolvedValue(undefined)
    await expect(reconcilePendingSwap(session, false, false, mined)).rejects.toThrow('catching up')
    expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
    expect(receipt).not.toHaveBeenCalled(); expect(state.sync).toHaveBeenLastCalledWith(session, mined)
    await expect(reconcilePendingSwap(session, false, false, mined)).resolves.toMatch(/Private output confirmed/)
    expect(state.remove).toHaveBeenCalledOnce()
  })
  it.each([0n, 1n])('finds a replacement hash and checks remaining funds after cleanup failure (%s)', async (leftover) => {
    const shield = PRIVACY.getEvent('Shield')
    const failure = ADAPT.getEvent('CallError')
    if (!shield || !failure) throw new Error('Missing events')
    const output = PRIVACY.encodeEventLog(shield, [
      0,
      0,
      [{ npk, token: { tokenAddress: TOKENS.WETH.address, tokenType: 0, tokenSubID: 0 }, value: 10n }],
      [],
      [],
    ])
    const cleanup = ADAPT.encodeEventLog(failure, [4, '0xdeadbeef'])
    const replacement = `0x${'22'.repeat(32)}`
    state.record = { ...pending }
    state.history.mockResolvedValue([
      { txid: replacement, blockNumber: 125, unshieldERC20Amounts: [{ recipientAddress: pending.account }] },
    ])
    receipt.mockImplementation(async (hash: string) =>
      hash === replacement
        ? {
            status: 1,
            blockHash: `0x${'44'.repeat(32)}`,
            blockNumber: 125,
            confirmations: async () => 2,
            logs: [
              spent,
              { address: CONFIG.proxyContract, ...output },
              { address: pending.account, ...cleanup },
            ],
          }
        : null,
    )
    balance.mockResolvedValue(`0x${leftover.toString(16).padStart(64, '0')}`)
    if (leftover > 0n) {
      await expect(reconcilePendingSwap(session)).rejects.toThrow(/still holds funds/)
      expect(state.remove).not.toHaveBeenCalled()
      expect(state.ratchet).not.toHaveBeenCalled()
      await expect(reconcilePendingSwap(session, false, true)).resolves.toMatch(/Private output confirmed/)
    } else {
      await expect(reconcilePendingSwap(session)).resolves.toMatch(/Private output confirmed.*cleanup call failed/)
    }
    expect(balance).toHaveBeenCalledTimes(ROUTE_INTERMEDIATES.length)
    expect(state.history).toHaveBeenCalledWith(CONFIG.chain, 'test-wallet', undefined)
    expect(state.remove).toHaveBeenCalledOnce()
  })
  it('does not silently discard damaged records', async () => {
    state.record = { ...pending, index: '3' }
    await expect(pendingSwap(session)).rejects.toThrow(/damaged/)
    expect(state.remove).not.toHaveBeenCalled()
  })
  it('keeps unknown submissions and unconfirmed hashes available for recovery', async () => {
    state.record = { ...pending, hash: undefined }
    await expect(reconcilePendingSwap(session)).rejects.toThrow(/outcome unknown/)
    state.record = pending
    receipt.mockResolvedValue(null)
    await expect(reconcilePendingSwap(session)).rejects.toThrow(/two confirmations/)
    expect(state.remove).not.toHaveBeenCalled()
    expect(state.ratchet).not.toHaveBeenCalled()
  })
  it('clears and advances only after the expected private output is confirmed', async () => {
    const event = PRIVACY.getEvent('Shield')
    if (!event) throw new Error('Missing upstream Shield event')
    const encoded = PRIVACY.encodeEventLog(event, [
      0,
      0,
      [{ npk, token: { tokenAddress: TOKENS.WETH.address, tokenType: 0, tokenSubID: 0 }, value: 10n }],
      [],
      [],
    ])
    state.record = pending
    receipt.mockResolvedValue({
      status: 1,
      blockHash: `0x${'44'.repeat(32)}`,
      blockNumber: 125,
      confirmations: async () => 2,
      logs: [spent, { address: CONFIG.proxyContract, ...encoded }],
    })
    await expect(reconcilePendingSwap(session)).resolves.toMatch(/Private output confirmed/)
    expect(state.ratchet).toHaveBeenCalledWith(1n, 4)
    expect(state.remove).toHaveBeenCalledOnce()
  })
  it('keeps a mined transaction with missing output pending', async () => {
    state.record = pending
    receipt.mockResolvedValue({ status: 1, blockNumber: 125, confirmations: async () => 2, logs: [spent] })
    await expect(reconcilePendingSwap(session, true)).rejects.toThrow(/not confirmed/)
    expect(state.remove).not.toHaveBeenCalled()
  })
  it('preserves older records for recovery instead of trusting an unrelated receipt', async () => {
    state.record = { ...pending, inputs: undefined }
    await expect(pendingSwap(session)).rejects.toThrow(/damaged/)
    const { inputs: _inputs, ...legacy } = pending
    state.record = legacy
    await expect(reconcilePendingSwap(session)).rejects.toThrow(/older swap record/)
    expect(state.remove).not.toHaveBeenCalled()
  })
  it.each(['missing-inputs', 'wrong-contract', 'wrong-tree', 'older-block'])('rejects %s even when the private output matches', async (reason) => {
    state.record = pending
    const output = PRIVACY.encodeEventLog('Shield', [0, 0,
      [{ npk, token: { tokenAddress: TOKENS.WETH.address, tokenType: 0, tokenSubID: 0 }, value: 10n }], [], []])
    receipt.mockResolvedValue({ status: 1, blockNumber: reason === 'older-block' ? 122 : 125,
      confirmations: async () => 2, logs: [{ address: CONFIG.proxyContract, ...output },
        ...(reason === 'missing-inputs' ? [] : [{ ...spent,
          ...(reason === 'wrong-tree' ? PRIVACY.encodeEventLog('Nullified', [1, [nullifier]]) : {}),
          address: reason === 'wrong-contract' ? pending.account : spent.address }])] })
    await expect(reconcilePendingSwap(session, true)).rejects.toThrow(/saved swap inputs/)
    expect(state.remove).not.toHaveBeenCalled()
    expect(state.ratchet).not.toHaveBeenCalled()
  })
})

function cleanupFailureReceipt(token = pending.token) {
  const output = PRIVACY.encodeEventLog('Shield', [0, 0,
    [{ npk, token: { tokenAddress: TOKENS[token].address, tokenType: 0, tokenSubID: 0 }, value: 10n }], [], []])
  return { status: 1, blockHash: `0x${'44'.repeat(32)}`, blockNumber: 125, confirmations: async () => 2, logs: [spent,
    { address: CONFIG.proxyContract, ...output },
    { address: pending.account, ...ADAPT.encodeEventLog('CallError', [4, '0xdeadbeef']) }] }
}

it.each([false, true])('does not query an unrelated hostile imported token during cleanup (legacy: %s)', async (legacy) => {
  const selected = registerToken({ address: '0x0000000000000000000000000000000000005678', symbol: 'USED', decimals: 18 })
  const unrelated = registerToken({ address: '0x0000000000000000000000000000000000009876', symbol: 'HOSTILE', decimals: 18 })
  state.record = legacy ? { ...pending, token: selected } : { ...pending, feeToken: 'WETH', recoveryTokens: ['WETH', selected] }
  receipt.mockResolvedValue(cleanupFailureReceipt(legacy ? selected : pending.token))
  balance.mockImplementation(async (request: { to: string }) => {
    if (request.to.toLowerCase() === TOKENS[unrelated].address.toLowerCase()) throw new Error('Unrelated token reverted')
    return `0x${'00'.repeat(32)}`
  })
  await expect(reconcilePendingSwap(session)).resolves.toContain('Private output confirmed')
  const queried = balance.mock.calls.map(([request]) => String(request.to).toLowerCase())
  const expected = legacy ? [...ROUTE_INTERMEDIATES, selected] : ['WETH', selected]
  expect(queried.sort()).toEqual(expected.map(id => TOKENS[id].address.toLowerCase()).sort())
  expect(queried).not.toContain(TOKENS[unrelated].address.toLowerCase())
  for (const [request] of balance.mock.calls) expect(request.gasLimit).toBe(100_000n)
  expect(state.remove).toHaveBeenCalledOnce()
})

it('retains a failed-cleanup record when a relevant token cannot be checked, unless leftovers are explicitly accepted', async () => {
  const selected = registerToken({ address: '0x0000000000000000000000000000000000005678', symbol: 'USED', decimals: 18 })
  const record = { ...pending, recoveryTokens: ['WETH', selected] }
  state.record = record; receipt.mockResolvedValue(cleanupFailureReceipt())
  balance.mockRejectedValue(new Error('Relevant token reverted'))
  await expect(reconcilePendingSwap(session)).rejects.toThrow('balances could not be verified')
  expect(state.record).toBe(record); expect(state.remove).not.toHaveBeenCalled(); expect(state.ratchet).not.toHaveBeenCalled()
  await expect(reconcilePendingSwap(session, false, true)).resolves.toContain('Private output confirmed')
  expect(state.remove).toHaveBeenCalledOnce()
})

it('round-trips a bounded recovery list and refuses damaged lists before replacing or clearing saved data', async () => {
  const valid = { ...pending, feeToken: 'USDC' as const, recoveryTokens: ['WETH', 'USDC'] as PendingSwap['recoveryTokens'] }
  await savePendingSwap(session, valid)
  expect((await pendingSwap(session))?.recoveryTokens).toEqual(['WETH', 'USDC'])
  const excessive = ['WETH', 'USDC', ...Array.from({ length: 7 }, (_, index) => registerToken({
    address: `0x${(20_000 + index).toString(16).padStart(40, '0')}`, symbol: 'X', decimals: 18,
  }))]
  for (const ids of [undefined, [], ['WETH', 'USDC', 'WETH'], ['WETH', 'USDC', 'UNKNOWN'], ['USDC'], ['WETH'], excessive, 'WETH']) {
    const saved = state.record, damaged = { ...valid, recoveryTokens: ids } as unknown as PendingSwap
    await expect(savePendingSwap(session, damaged)).rejects.toThrow('recovery assets are damaged')
    expect(state.record).toBe(saved)
    state.record = damaged
    await expect(pendingSwap(session)).rejects.toThrow('recovery assets are damaged')
    expect(state.remove).not.toHaveBeenCalled()
    state.record = saved
  }
})
