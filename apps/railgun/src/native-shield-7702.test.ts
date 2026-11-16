import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Wallet, ZeroHash, type JsonRpcSigner, type TransactionRequest } from 'ethers'
import { RelayAdapt7702ExecutionType, RelayAdapt7702Helper } from '@railgun-community/engine'
import type { WalletSession } from './wallet'

const mocks = vi.hoisted(() => ({ account: vi.fn(), populate: vi.fn() }))
vi.mock('./account', () => ({ unusedNativeShieldAccount: mocks.account }))
vi.mock('@railgun-community/wallet', () => ({ populateShieldBaseToken: mocks.populate, populateShield: vi.fn() }))
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '8453')
  vi.stubEnv('VITE_RAILGUN_ENVIRONMENT', 'mainnet')
  mocks.account.mockReset()
  mocks.populate.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

async function fixture(change?: string) {
  const { ADAPT, PRIVACY, assertNativeShield } = await import('./execution')
  const { CONFIG } = await import('./config')
  const account = Wallet.createRandom(), amount = 10n ** 15n
  const note = { npk: `0x${'11'.repeat(32)}`, value: change === 'shield-amount' ? amount - 1n : amount,
    token: { tokenAddress: change === 'token' ? account.address : CONFIG.baseToken.wrappedAddress, tokenType: 0, tokenSubID: 0 } }
  const shieldRequest = { preimage: note, ciphertext: { encryptedBundle: [ZeroHash, ZeroHash, ZeroHash], shieldKey: ZeroHash } }
  const action = { requireSuccess: change !== 'non-atomic', minGasLimit: 0n, calls: [
    { to: change === 'call-target' ? CONFIG.proxyContract : account.address, value: 0n,
      data: ADAPT.encodeFunctionData('wrapBase', [change === 'wrap-amount' ? amount - 1n : amount]) },
    { to: account.address, value: 0n, data: ADAPT.encodeFunctionData('shield', [[shieldRequest]]) },
  ] }
  const execution = { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n }
  const signature = await RelayAdapt7702Helper.signExecutionAuthorization(account, [], action, 8453n, execution)
  const authorization = await account.authorize({ chainId: change === 'chain' ? 1n : 8453n,
    address: change === 'delegate' ? account.address : CONFIG.relayAdapt7702Contract, nonce: change === 'nonce' ? 1 : 0 })
  const transaction: TransactionRequest = { type: 4, to: account.address, value: change === 'value' ? amount + 1n : amount,
    authorizationList: [authorization], data: ADAPT.encodeFunctionData('execute', [[], action, 0n, signature]) }
  if (change === 'signature') transaction.data = ADAPT.encodeFunctionData('execute', [[], action, 0n, `0x${'00'.repeat(65)}`])
  const event = PRIVACY.getEvent('Shield')!
  const log = { address: CONFIG.proxyContract, ...PRIVACY.encodeEventLog(event, [0, 0, [{ ...note, value: amount * 9975n / 10_000n }], [], [amount * 25n / 10_000n]]) }
  return { account, amount, note, transaction, log, assertNativeShield }
}

it('accepts the Base delegate authorization and exact signed atomic wrap/shield action', async () => {
  const f = await fixture()
  expect(f.assertNativeShield(f.transaction, f.account.address, f.amount)).toBe(f.note.npk)
})

it.each(['chain', 'delegate', 'nonce', 'value', 'non-atomic', 'call-target', 'wrap-amount', 'shield-amount', 'token', 'signature'])(
  'rejects a native shield with changed %s', async change => {
    const f = await fixture(change)
    expect(() => f.assertNativeShield(f.transaction, f.account.address, f.amount)).toThrow()
  })

it('routes new Base native deposits through wrapping before requesting a wallet transaction', async () => {
  const f = await fixture(), { shield } = await import('./shield')
  mocks.account.mockResolvedValue(f.account)
  mocks.populate.mockResolvedValue({ transaction: f.transaction })
  const receipt = { hash: ZeroHash, status: 1, logs: [f.log] }
  const send = vi.fn().mockResolvedValue({ wait: async () => receipt })
  const signer = { getAddress: async () => f.account.address, sendTransaction: send,
    provider: { getNetwork: async () => ({ chainId: 8453n }), getBalance: async () => f.amount,
      send: async () => [f.account.address] } } as unknown as JsonRpcSigner
  const session = { info: { railgunAddress: 'test-private-recipient' } } as WalletSession
  await expect(shield(session, signer, 'ETH', f.amount)).rejects.toThrow('wrap ETH into WETH first')
  expect(mocks.account).not.toHaveBeenCalled()
  expect(mocks.populate).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
})
