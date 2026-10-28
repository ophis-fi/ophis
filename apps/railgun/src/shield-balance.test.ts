import { beforeEach, expect, it, vi } from 'vitest'
import { parseEther, type JsonRpcSigner } from 'ethers'
import type { WalletSession } from './wallet'

const mocks = vi.hoisted(() => ({ balance: vi.fn(), allowance: vi.fn(), approve: vi.fn(), populate: vi.fn(), populateBase: vi.fn() }))
vi.mock('ethers', async (original) => ({
  ...await original<typeof import('ethers')>(),
  Contract: class {
    getFunction(name: 'balanceOf' | 'allowance' | 'approve') { return { balanceOf: mocks.balance, allowance: mocks.allowance, approve: mocks.approve }[name] }
  },
}))
vi.mock('@railgun-community/wallet', () => ({ populateShield: mocks.populate, populateShieldBaseToken: mocks.populateBase }))
vi.mock('./config', async (original) => ({ ...await original<typeof import('./config')>(), ENVIRONMENT: 'ethereum' }))
const { approveShield, requireShieldBalance, shield } = await import('./shield')
const { CONFIG, TOKENS } = await import('./config')

it('resets an existing USDT allowance before approving the requested amount', async () => {
  mocks.balance.mockResolvedValue(2_000_000n)
  mocks.allowance.mockResolvedValue(1n)
  mocks.approve.mockResolvedValue({ wait: async () => ({ status: 1 }) })
  await approveShield(session, signer, 'USDT', 1_000_000n)
  expect(mocks.approve).toHaveBeenNthCalledWith(1, CONFIG.proxyContract, 0n)
  expect(mocks.approve).toHaveBeenNthCalledWith(2, CONFIG.proxyContract, 1_000_000n)
})

it('stops a USDT approval if the public wallet changes networks during its reset', async () => {
  mocks.balance.mockResolvedValue(2_000_000n)
  mocks.allowance.mockResolvedValue(1n)
  mocks.approve.mockResolvedValue({ wait: async () => { network.mockResolvedValue({ chainId: 56n }); return { status: 1 } } })
  await expect(approveShield(session, signer, 'USDT', 1_000_000n)).rejects.toThrow(/Switch your public wallet/)
  expect(mocks.approve).toHaveBeenCalledTimes(1)
})

const owner = '0x0000000000000000000000000000000000000001'
const session = { info: { railgunAddress: 'private recipient' } } as unknown as WalletSession
const send = vi.fn()
const nativeBalance = vi.fn()
const network = vi.fn()
const signer = {
  getAddress: async () => owner,
  provider: { getNetwork: network, getBalance: nativeBalance },
  sendTransaction: send,
} as unknown as JsonRpcSigner
beforeEach(() => {
  mocks.balance.mockReset().mockResolvedValue(0n)
  mocks.allowance.mockReset().mockResolvedValue(parseEther('0.001'))
  mocks.approve.mockReset()
  mocks.populate.mockReset()
  mocks.populateBase.mockReset()
  nativeBalance.mockReset().mockResolvedValue(parseEther('0.01'))
  network.mockReset().mockResolvedValue({ chainId: 1n })
  send.mockReset()
})

it.each(['approval', 'shield'])('blocks %s with zero WETH despite sufficient allowance, before any wallet transaction', async (action) => {
  await expect((action === 'approval' ? approveShield : shield)(session, signer, 'WETH', parseEther('0.001')))
    .rejects.toThrow(/Public wallet balance: 0\.0 WETH\.[\s\S]*Required to shield: 0\.001 WETH\.[\s\S]*Choose ETH as the deposit asset/)
  expect(mocks.balance).toHaveBeenCalledWith(owner)
  expect(mocks.approve).not.toHaveBeenCalled()
  expect(mocks.populate).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it('deposits native ETH through the canonical relay with the exact value and private recipient, without an ERC20 balance or allowance', async () => {
  const amount = parseEther('0.001')
  const transaction = { to: CONFIG.relayAdaptContract, value: amount, data: 'native shield calldata' }
  const receipt = { status: 1, hash: 'native deposit' }
  const report = vi.fn()
  mocks.populateBase.mockResolvedValue({ transaction })
  send.mockResolvedValue({ wait: async () => receipt })
  await expect(shield(session, signer, 'ETH', amount, report)).resolves.toBe(receipt)
  expect(nativeBalance).toHaveBeenCalledWith(owner)
  expect(mocks.balance).not.toHaveBeenCalled()
  expect(mocks.allowance).not.toHaveBeenCalled()
  expect(mocks.approve).not.toHaveBeenCalled()
  expect(mocks.populate).not.toHaveBeenCalled()
  expect(mocks.populateBase).toHaveBeenCalledWith(expect.anything(), expect.anything(), session.info.railgunAddress, expect.stringMatching(/^0x[0-9a-f]{64}$/), {
    tokenAddress: TOKENS.WETH.address, amount, recipientAddress: session.info.railgunAddress,
  })
  expect(send).toHaveBeenCalledExactlyOnceWith(transaction)
  expect(report.mock.calls.map(([message]) => message)).toEqual([
    'Checking your public wallet network and balance…',
    'Preparing your ETH deposit…',
    expect.stringContaining('Confirm the 0.001 ETH deposit'),
    expect.stringContaining('Deposit submitted:'),
    'Deposit confirmed: native deposit. Railgun validation usually takes about one hour. Use Refresh balances afterward and wait for Spendable before a private swap.',
  ])
})

it('rejects insufficient ETH before populating or sending', async () => {
  nativeBalance.mockResolvedValue(parseEther('0.0009'))
  await expect(shield(session, signer, 'ETH', parseEther('0.001'))).rejects.toThrow(/balance: 0\.0009 ETH[\s\S]*0\.001 ETH[\s\S]*plus ETH for gas/)
  expect(mocks.populateBase).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})

it.each(['destination', 'value', 'network'])('blocks native shield when the %s changes before sending', async (changed) => {
  const amount = parseEther('0.001')
  mocks.populateBase.mockResolvedValue({ transaction: {
    to: changed === 'destination' ? owner : CONFIG.relayAdaptContract,
    value: changed === 'value' ? amount + 1n : amount,
  } })
  if (changed === 'network') network.mockResolvedValueOnce({ chainId: 1n }).mockResolvedValueOnce({ chainId: 10n })
  await expect(shield(session, signer, 'ETH', amount)).rejects.toThrow(changed === 'network' ? /Switch your public wallet to Ethereum/ : /does not match/)
  expect(send).not.toHaveBeenCalled()
})

it('rejects an unconfirmed native deposit receipt', async () => {
  const amount = parseEther('0.001')
  mocks.populateBase.mockResolvedValue({ transaction: { to: CONFIG.relayAdaptContract, value: amount } })
  send.mockResolvedValue({ wait: async () => ({ status: 0 }) })
  await expect(shield(session, signer, 'ETH', amount)).rejects.toThrow(/Shield was not confirmed/)
})

it('uses the selected token decimals, requires a positive amount and rechecks the current balance', async () => {
  mocks.balance.mockResolvedValueOnce(999_999n).mockResolvedValueOnce(1_000_000n).mockResolvedValueOnce(0n)
  await expect(requireShieldBalance(signer, 'USDC', 1_000_000n)).rejects.toThrow(/0\.999999 USDC[\s\S]*1\.0 USDC/)
  await expect(requireShieldBalance(signer, 'USDC', 1_000_000n)).resolves.toBeUndefined()
  await expect(requireShieldBalance(signer, 'USDC', 1_000_000n)).rejects.toThrow(/balance: 0\.0 USDC/)
  mocks.balance.mockClear()
  await expect(requireShieldBalance(signer, 'WETH', 0n)).rejects.toThrow(/positive token amount/)
  expect(mocks.balance).not.toHaveBeenCalled()
})

it('allows an exactly funded WETH shield and retains the allowance check and confirmed receipt', async () => {
  mocks.balance.mockResolvedValue(parseEther('0.001'))
  mocks.allowance.mockResolvedValueOnce(0n)
  await expect(shield(session, signer, 'WETH', parseEther('0.001'))).rejects.toThrow(/Approve this token amount first/)
  expect(mocks.populate).not.toHaveBeenCalled()
  const transaction = { to: 'proxy', data: 'shield calldata' }
  const receipt = { status: 1, hash: 'confirmed shield' }
  mocks.populate.mockResolvedValue({ transaction })
  send.mockResolvedValue({ wait: async () => receipt })
  await expect(shield(session, signer, 'WETH', parseEther('0.001'))).resolves.toBe(receipt)
  expect(send).toHaveBeenCalledExactlyOnceWith(transaction)
  expect(mocks.populate.mock.calls[0][3]).toEqual([{ tokenAddress: expect.any(String), amount: parseEther('0.001'), recipientAddress: 'private recipient' }])
})
