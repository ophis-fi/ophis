import { beforeEach, expect, it, vi } from 'vitest'
import { Wallet, authorizationify, type JsonRpcSigner } from 'ethers'
import { RelayAdapt7702ExecutionType, RelayAdapt7702Helper, TXIDVersion, type TransactionStructV2 } from '@railgun-community/engine'
import { CHAIN, CONFIG, TOKENS, registerToken } from './config'
import { ADAPT, PRIVACY } from './execution'
import { mixedWithdrawalTransactions, withdrawalData } from '../tests/withdrawal.fixture'
import type { WalletSession } from './wallet'
import type { PendingWithdrawal } from './withdrawal-journal'

const state = vi.hoisted(() => ({ pending: undefined as unknown, save: vi.fn(), remove: vi.fn(), network: vi.fn() }))
vi.mock('./storage', () => ({ readPrivateState: async () => state.pending, writePrivateState: state.save, deletePrivateState: state.remove }))
vi.mock('./shield', () => ({ assertPublicNetwork: state.network }))
import { resumePendingWithdrawal } from './withdrawal-journal'

const token = registerToken({ address: '0x0000000000000000000000000000000000004321', symbol: 'CUSTOM', decimals: 8 })
const recipient = '0x0000000000000000000000000000000000001234'
const oldHash = `0x${'33'.repeat(32)}`, newHash = `0x${'44'.repeat(32)}`
const rejection = 'External EIP-7702 transactions are not supported'
const session = { info: { id: 'synthetic-wallet' }, provider: {
  getBlockNumber: async () => 102,
  call: async () => PRIVACY.encodeFunctionResult('nullifiers', [false]),
  getFeeData: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
} } as unknown as WalletSession
let pending: PendingWithdrawal

beforeEach(async () => {
  vi.resetAllMocks()
  // Fresh synthetic account/signatures; no owner wallet, provider, or proof is loaded.
  const account = Wallet.createRandom()
  const proofs = mixedWithdrawalTransactions(token, account.address).map((tx) => ({ ...tx,
    txidVersion: TXIDVersion.V2_PoseidonMerkle,
    boundParams: { ...tx.boundParams, chainID: CHAIN, adaptContract: account.address },
  })) as unknown as TransactionStructV2[]
  const action = RelayAdapt7702Helper.getActionData(true, [{ to: account.address, value: 0n,
    data: ADAPT.encodeFunctionData('transfer', [[{ token: { tokenType: 0, tokenAddress: token, tokenSubID: 0 }, to: recipient, value: 998n }]]) }], 0n)
  const details = { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n }
  const authorization = await account.authorize({ address: CONFIG.relayAdapt7702Contract, chainId: CHAIN, nonce: 0 })
  const signature = await RelayAdapt7702Helper.signExecutionAuthorization(account, proofs, action, CHAIN, details)
  pending = { token, feeToken: 'WETH', broadcaster: 'synthetic-broadcaster', recipient, minimum: '998', fromBlock: 100,
    hash: oldHash, nullifiers: proofs.flatMap((tx) => tx.nullifiers.map(String)), minGasPrice: '0',
    transaction: { to: account.address, value: '0', data: RelayAdapt7702Helper.encodeExecute(ADAPT, proofs, action, signature, details) },
    execution: { index: 7, account: account.address, executeNonce: '0', gasEstimate: '3000000', maxFeePerGas: '100', maxPriorityFeePerGas: '10',
      authorization: { address: authorization.address, chainId: CHAIN.toString(), nonce: '0', signature: authorization.signature.serialized } } }
  state.pending = pending
  state.save.mockImplementation(async (_session, _key, record) => { state.pending = record })
})

it.each([
  ['direct', new Error(rejection)],
  ['RPC wrapper', { message: 'could not coalesce error', error: { code: -32602, message: rejection } }],
  ['estimate wrapper', { message: 'missing revert data', info: { error: { code: -32602, message: rejection } } }],
])('explains an explicit unsupported-wallet %s rejection and preserves the exact proof and prior hash', async (_label, error) => {
  const sendTransaction = vi.fn().mockRejectedValue(error)
  const sponsor = { sendTransaction } as unknown as JsonRpcSigner
  await expect(resumePendingWithdrawal(session, sponsor)).rejects.toThrow(
    'The complete saved proof is preserved. Retry through the broadcaster, resume with a compatible public wallet, or invalidate the saved authorization.',
  )
  expect(sendTransaction).toHaveBeenCalledOnce()
  expect(state.pending).toBe(pending)
  expect((state.pending as PendingWithdrawal).hash).toBe(oldHash)
  expect(state.save).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled()
})

it('still sends the exact authorization and proof with a compatible wallet and retains its unconfirmed hash', async () => {
  const wait = vi.fn().mockResolvedValue(null)
  const sendTransaction = vi.fn().mockResolvedValue({ hash: newHash, wait })
  const sponsor = { sendTransaction } as unknown as JsonRpcSigner
  const beforeSend = vi.fn()
  await expect(resumePendingWithdrawal(session, sponsor, beforeSend)).rejects.toThrow('Withdrawal confirmation is pending')
  expect(state.network).toHaveBeenCalledWith(session, sponsor, beforeSend)
  expect(sendTransaction).toHaveBeenCalledWith({ ...pending.transaction, value: 0n, type: 4, chainId: CHAIN,
    authorizationList: [authorizationify(pending.execution!.authorization)], maxFeePerGas: 100n, maxPriorityFeePerGas: 10n })
  expect(wait).toHaveBeenCalledWith(2)
  expect(state.pending).toEqual({ ...pending, hash: newHash, chainId: Number(CHAIN) })
  expect(state.remove).not.toHaveBeenCalled()
})

it('does not relabel user rejection, insufficient funds, or uncertain network errors as incompatibility', async () => {
  for (const message of ['User rejected request', 'Insufficient funds', 'Network timeout; outcome unknown']) {
    const error = new Error(message)
    const sponsor = { sendTransaction: vi.fn().mockRejectedValue(error) } as unknown as JsonRpcSigner
    await expect(resumePendingWithdrawal(session, sponsor)).rejects.toBe(error)
    expect(state.pending).toBe(pending)
  }
  expect(state.save).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled()
})

it('leaves ordinary atomic-withdrawal wallet errors unchanged', async () => {
  state.pending = { ...pending, token: 'WETH', execution: undefined, nullifiers: [`0x${'11'.repeat(32)}`],
    transaction: { to: CONFIG.proxyContract, data: withdrawalData(1, 1, recipient, TOKENS.WETH.address), value: '0' } }
  const error = new Error(rejection)
  const sendTransaction = vi.fn().mockRejectedValue(error)
  await expect(resumePendingWithdrawal(session, { sendTransaction } as unknown as JsonRpcSigner)).rejects.toBe(error)
  expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 2 }))
  expect(state.save).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled()
})
