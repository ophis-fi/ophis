import { beforeEach, expect, it, vi } from 'vitest'
import { Interface, type JsonRpcSigner } from 'ethers'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ allowance: 5n, balance: 1000n, call: vi.fn(), approve: vi.fn(), send: vi.fn(),
  populate: vi.fn(), network: vi.fn(), resetStatus: 1, exactStatus: 1, applyApproval: true }))
vi.mock('ethers', async (original) => ({ ...await original<typeof import('ethers')>(),
  Contract: class {
    getFunction(name: string) {
      if (name === 'balanceOf') return async () => state.balance
      if (name === 'allowance') return async () => state.allowance
      if (name === 'approve') return state.approve
      throw new Error(`Unexpected method ${name}`)
    }
  } }))
vi.mock('@railgun-community/wallet', () => ({ populateShield: state.populate, populateShieldBaseToken: vi.fn() }))
vi.mock('./config', async (original) => ({ ...await original<typeof import('./config')>(), ENVIRONMENT: 'ethereum' }))

const owner = '0x0000000000000000000000000000000000001234'
const abi = new Interface(['function approve(address spender,uint256 amount) returns (bool)'])
const trueResult = abi.encodeFunctionResult('approve', [true])
const falseResult = abi.encodeFunctionResult('approve', [false])
const provider = { call: state.call, getNetwork: state.network, getBalance: async () => 1n, send: vi.fn(async () => [owner]) }
const signer = { getAddress: async () => owner, provider, sendTransaction: state.send } as unknown as JsonRpcSigner
const session = { info: { railgunAddress: 'generated-test-private-address' }, provider,
  accounts: { getAccount: async () => ({ address: owner, signer: { connect: () => signer } }) } } as unknown as WalletSession

beforeEach(() => {
  state.allowance = 5n
  state.balance = 1000n
  state.resetStatus = 1
  state.exactStatus = 1
  state.applyApproval = true
  provider.send.mockReset().mockResolvedValue([owner])
  state.network.mockReset().mockResolvedValue({ chainId: 1n })
  state.call.mockReset().mockResolvedValue(trueResult)
  state.approve.mockReset().mockImplementation(async (_spender: string, amount: bigint) => ({ hash: `approval-${amount}`,
    wait: async () => {
      const status = amount === 0n ? state.resetStatus : state.exactStatus
      if (status === 1 && state.applyApproval) state.allowance = amount
      return { status, hash: `receipt-${amount}` }
    } }))
  state.populate.mockReset().mockResolvedValue({ transaction: { to: 'canonical-shield', data: 'generated-shield' } })
  state.send.mockReset().mockResolvedValue({ hash: 'recovered-shield', wait: async () => ({ status: 1 }) })
})

it.each(['standard', 'no-return', 'reset-required'])('preflights %s token approvals and sends only the canonical spender with exact amounts', async (behavior) => {
  const { CONFIG, TOKENS } = await import('./config')
  const { approveShield } = await import('./shield')
  state.call.mockImplementation(async (tx: { from: string; to: string; data: string; value: bigint; gasLimit: bigint }) => {
    const [spender, amount] = abi.decodeFunctionData('approve', tx.data)
    expect(tx.from).toBe(owner); expect(tx.to.toLowerCase()).toBe(TOKENS.USDC.address.toLowerCase())
    expect(tx.value).toBe(0n); expect(tx.gasLimit).toBe(200_000n)
    expect(spender.toLowerCase()).toBe(CONFIG.proxyContract.toLowerCase())
    if (behavior === 'reset-required' && amount > 0n && state.allowance > 0n) throw new Error('Must reset first')
    return behavior === 'no-return' ? '0x' : trueResult
  })
  await expect(approveShield(session, signer, 'USDC', 100n)).resolves.toMatchObject({ status: 1 })
  expect(state.approve.mock.calls).toEqual([[CONFIG.proxyContract, 0n, { chainId: 1n, from: owner }], [CONFIG.proxyContract, 100n, { chainId: 1n, from: owner }]])
  expect(state.allowance).toBe(100n)
  expect(state.call).toHaveBeenCalledTimes(2)
})

it.each(['revert', 'false', 'malformed'])('uses a preflighted direct exact approval when approve(0) returns %s, without a paid reset', async (zeroBehavior) => {
  const { CONFIG } = await import('./config')
  const { approveShield } = await import('./shield')
  state.call.mockImplementation(async (tx: { data: string }) => {
    const [, amount] = abi.decodeFunctionData('approve', tx.data)
    if (amount !== 0n) return '0x'
    if (zeroBehavior === 'revert') throw new Error('Zero approvals rejected')
    return zeroBehavior === 'false' ? falseResult : '0x01'
  })
  await expect(approveShield(session, signer, 'USDC', 100n)).resolves.toMatchObject({ status: 1 })
  expect(state.approve.mock.calls).toEqual([[CONFIG.proxyContract, 100n, { chainId: 1n, from: owner }]])
  expect(state.allowance).toBe(100n)
})

it.each(['false', 'malformed', 'revert'])('rejects an unsupported exact approval (%s) without sending any wallet transaction', async (behavior) => {
  const { approveShield } = await import('./shield')
  state.allowance = 0n
  state.call.mockImplementation(async () => {
    if (behavior === 'revert') throw new Error('Approval rejected')
    return behavior === 'false' ? falseResult : '0x01'
  })
  await expect(approveShield(session, signer, 'USDC', 100n)).rejects.toThrow('does not support the exact approval')
  expect(state.approve).not.toHaveBeenCalled()
  expect(state.send).not.toHaveBeenCalled()
})

it('never falls back after a reset transaction is broadcast and reverts', async () => {
  const { approveShield } = await import('./shield')
  state.resetStatus = 0
  await expect(approveShield(session, signer, 'USDC', 100n)).rejects.toThrow('reset was not confirmed')
  expect(state.approve).toHaveBeenCalledTimes(1)
  expect(state.call).toHaveBeenCalledTimes(1)
  expect(state.allowance).toBe(5n)
})

it('does not report approval when a successful receipt failed to set the exact allowance', async () => {
  const { approveShield } = await import('./shield')
  state.allowance = 0n
  state.applyApproval = false
  await expect(approveShield(session, signer, 'USDC', 100n)).rejects.toThrow('Exact token approval was not confirmed')
  expect(state.approve).toHaveBeenCalledTimes(1)
})

it('reuses the same no-return/reset-required approval policy for temporary-account recovery', async () => {
  const { CONFIG, TOKENS } = await import('./config')
  const { recoverToken } = await import('./recovery')
  state.call.mockImplementation(async (tx: { data: string }) => {
    const [, amount] = abi.decodeFunctionData('approve', tx.data)
    if (amount > 0n && state.allowance > 0n) throw new Error('Must reset first')
    return '0x'
  })
  await expect(recoverToken(session, 0, 'USDC')).resolves.toBe('recovered-shield')
  expect(state.approve.mock.calls).toEqual([[CONFIG.proxyContract, 0n, { chainId: 1n, from: owner }], [CONFIG.proxyContract, 1000n, { chainId: 1n, from: owner }]])
  expect(state.populate.mock.calls[0][3]).toEqual([{ tokenAddress: TOKENS.USDC.address, amount: 1000n, recipientAddress: session.info.railgunAddress }])
  expect(state.send).toHaveBeenCalledTimes(1)
})

it.each([2n ** 120n, 2n ** 120n + 1n])('rejects a recovery balance outside the Railgun amount limit before any approval: %s', async (balance) => {
  const { recoverToken } = await import('./recovery')
  state.balance = balance
  await expect(recoverToken(session, 0, 'USDC')).rejects.toThrow('exceeds the Railgun amount limit')
  expect(state.approve).not.toHaveBeenCalled()
  expect(state.call).not.toHaveBeenCalled()
  expect(state.populate).not.toHaveBeenCalled()
  expect(state.send).not.toHaveBeenCalled()
})

it('rejects an oversized public shield before approval, transaction population, or submission', async () => {
  const { approveShield, shield } = await import('./shield')
  for (const action of [approveShield, shield])
    await expect(action(session, signer, 'USDC', 2n ** 120n)).rejects.toThrow('Token amount is out of range')
  expect(state.approve).not.toHaveBeenCalled()
  expect(state.call).not.toHaveBeenCalled()
  expect(state.populate).not.toHaveBeenCalled()
  expect(state.send).not.toHaveBeenCalled()
})

it.each(['network', 'account', 'session'])('rejects a %s change during exact approval preparation before sending', async (change) => {
  const { approveShield } = await import('./shield')
  state.allowance = 0n
  let changed = false
  const status = () => {
    changed = true
    if (change === 'network') state.network.mockResolvedValue({ chainId: 56n })
    if (change === 'account') provider.send.mockResolvedValue(['0x0000000000000000000000000000000000004321'])
  }
  const current = () => { if (change === 'session' && changed) throw new Error('Public session changed') }
  await expect(approveShield(session, signer, 'USDC', 100n, status, current)).rejects.toThrow(/changed|Switch your public wallet/)
  expect(state.approve).not.toHaveBeenCalled()
})

it('binds deposits to the selected chain and stops a changed account before the wallet request', async () => {
  const { shield } = await import('./shield')
  state.allowance = 100n
  await shield(session, signer, 'USDC', 100n)
  expect(state.send).toHaveBeenCalledWith(expect.objectContaining({ chainId: 1n }))
  state.send.mockClear()
  await expect(shield(session, signer, 'USDC', 100n, message => {
    if (message.startsWith('Confirm the')) provider.send.mockResolvedValue([])
  })).rejects.toThrow('account changed')
  expect(state.send).not.toHaveBeenCalled()
})
