import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG, TOKENS } from './config'
import { ADAPT, PRIVACY } from './execution'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ record: undefined as unknown, ratchet: vi.fn(), remove: vi.fn(), history: vi.fn() }))
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
import { pendingSwap, reconcilePendingSwap } from './journal'

const npk = `0x${'01'.padStart(64, '0')}`
const pending = {
  index: 3,
  account: '0x0000000000000000000000000000000000001234',
  token: 'WETH',
  minimum: '10',
  npk,
  hash: `0x${'11'.repeat(32)}`,
  executeNonce: '0',
  fromBlock: 123,
}
const receipt = vi.fn()
const session = {
  info: { id: 'test-wallet' },
  provider: { getTransactionReceipt: receipt },
} as unknown as WalletSession

beforeEach(() => {
  state.record = undefined
  vi.clearAllMocks()
  state.history.mockResolvedValue([])
})

describe('pending swap recovery journal', () => {
  it('finds a replacement hash and confirms private output even if a later cleanup call fails', async () => {
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
    state.record = pending
    state.history.mockResolvedValue([
      { txid: replacement, blockNumber: 125, unshieldERC20Amounts: [{ recipientAddress: pending.account }] },
    ])
    receipt.mockImplementation(async (hash: string) =>
      hash === replacement
        ? {
            status: 1,
            confirmations: async () => 2,
            logs: [
              { address: CONFIG.proxyContract, ...output },
              { address: pending.account, ...cleanup },
            ],
          }
        : null,
    )
    await expect(reconcilePendingSwap(session)).resolves.toMatch(/Private output confirmed.*cleanup call failed/)
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
      confirmations: async () => 2,
      logs: [{ address: CONFIG.proxyContract, ...encoded }],
    })
    await expect(reconcilePendingSwap(session)).resolves.toMatch(/Private output confirmed/)
    expect(state.ratchet).toHaveBeenCalledWith(1n, 4)
    expect(state.remove).toHaveBeenCalledOnce()
  })
  it('keeps a mined transaction with missing output pending', async () => {
    state.record = pending
    receipt.mockResolvedValue({ status: 1, confirmations: async () => 2, logs: [] })
    await expect(reconcilePendingSwap(session, true)).rejects.toThrow(/not confirmed/)
    expect(state.remove).not.toHaveBeenCalled()
  })
})
