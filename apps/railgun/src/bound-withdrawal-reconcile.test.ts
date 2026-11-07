import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Interface, Wallet, type TransactionReceipt } from 'ethers'
import { RelayAdapt7702ExecutionType, RelayAdapt7702Helper, TXIDVersion, type TransactionStructV2 } from '@railgun-community/engine'
import type { WalletSession } from './wallet'
import { mixedWithdrawalTransactions } from '../tests/withdrawal.fixture'

const state = vi.hoisted(() => ({ pending: undefined as unknown, remove: vi.fn(), ratchet: vi.fn(), history: vi.fn(), receipt: vi.fn() }))
vi.mock('./storage', () => ({ readPrivateState: async () => state.pending, writePrivateState: vi.fn(), deletePrivateState: state.remove }))
vi.mock('@railgun-community/wallet', async (original) => ({ ...await original<typeof import('@railgun-community/wallet')>(),
  fullWalletForID: () => ({ setEphemeralKeyIndexIfGreater: state.ratchet }), getWalletTransactionHistory: state.history }))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '56')
  state.pending = undefined
  state.remove.mockReset().mockResolvedValue(undefined)
  state.ratchet.mockReset().mockResolvedValue(undefined)
  state.history.mockReset().mockResolvedValue([])
  state.receipt.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

const session = { info: { id: 'generated-test-wallet' }, provider: { getTransactionReceipt: state.receipt } } as unknown as WalletSession

async function confirmedBoundRecord(lostResponse = false) {
  const { CONFIG, FEE_SIGNER, TOKENS } = await import('./config')
  const { ADAPT, PRIVACY } = await import('./execution')
  const owner = Wallet.createRandom()
  const recipient = '0x0000000000000000000000000000000000005678'
  const proofs = mixedWithdrawalTransactions(TOKENS.USDC.address, recipient)
    .map((tx) => ({ ...tx, txidVersion: TXIDVersion.V2_PoseidonMerkle })) as unknown as TransactionStructV2[]
  for (const proof of proofs) proof.boundParams.adaptContract = owner.address
  proofs[1].unshieldPreimage.npk = `0x${owner.address.slice(2).padStart(64, '0')}`
  const action = RelayAdapt7702Helper.getActionData(true, [{ to: owner.address, value: 0n,
    data: ADAPT.encodeFunctionData('transfer', [[{ token: { tokenType: 0, tokenAddress: TOKENS.USDC.address, tokenSubID: 0 }, to: recipient, value: 998n }]]) }], 0n)
  const details = { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n }
  const authorization = await owner.authorize({ address: CONFIG.relayAdapt7702Contract, chainId: 56, nonce: 0 })
  const signature = await RelayAdapt7702Helper.signExecutionAuthorization(owner, proofs, action, 56n, details)
  const data = RelayAdapt7702Helper.encodeExecute(ADAPT, proofs, action, signature, details)
  const hash = `0x${'44'.repeat(32)}`
  const pending = { chainId: 56, token: 'USDC' as const, feeToken: 'WBNB' as const, broadcaster: FEE_SIGNER,
    recipient, minimum: '998', fromBlock: 100, ...(lostResponse ? {} : { hash }),
    transaction: { to: owner.address, data, value: '0' }, nullifiers: proofs.flatMap((proof) => proof.nullifiers.map(String)), minGasPrice: '0',
    execution: { index: 7, account: owner.address, executeNonce: '0', gasEstimate: '3000000', maxFeePerGas: '50000000', maxPriorityFeePerGas: '50000000',
      authorization: { address: authorization.address, chainId: '56', nonce: '0', signature: authorization.signature.serialized } } }
  const token = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)'])
  const receipt = { status: 1, blockNumber: 102, confirmations: async () => 2,
    logs: [
      { address: CONFIG.proxyContract, ...PRIVACY.encodeEventLog('Nullified', [0, pending.nullifiers]) },
      { address: TOKENS.USDC.address, ...token.encodeEventLog('Transfer', [owner.address, recipient, 998n]) },
    ] } as unknown as TransactionReceipt
  state.pending = pending
  state.receipt.mockResolvedValue(receipt)
  if (lostResponse) state.history.mockResolvedValue([{ txid: hash.slice(2), blockNumber: 102, unshieldERC20Amounts: [{ recipientAddress: owner.address }] }])
  return { pending, hash }
}

it.each([false, true])('persists the used account index before deleting a confirmed bound record (lost response: %s)', async (lostResponse) => {
  const { pending, hash } = await confirmedBoundRecord(lostResponse)
  let finish: (() => void) | undefined
  state.ratchet.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  const { reconcilePendingWithdrawal } = await import('./withdrawal-journal')
  const result = reconcilePendingWithdrawal(session)
  await vi.waitFor(() => expect(state.ratchet).toHaveBeenCalledWith(56n, 8))
  expect(state.remove).not.toHaveBeenCalled()
  expect(state.pending).toBe(pending)
  finish?.()
  await expect(result).resolves.toContain(hash)
  expect(state.remove).toHaveBeenCalledWith(session, 'pendingWithdrawal')
  expect(state.ratchet.mock.invocationCallOrder[0]).toBeLessThan(state.remove.mock.invocationCallOrder[0])
})

it('retains the exact signed record if the account-index update fails, then safely retries reconciliation', async () => {
  const { pending } = await confirmedBoundRecord()
  state.ratchet.mockRejectedValueOnce(new Error('Wallet index persistence failed'))
  const { reconcilePendingWithdrawal } = await import('./withdrawal-journal')
  await expect(reconcilePendingWithdrawal(session)).rejects.toThrow('Wallet index persistence failed')
  expect(state.remove).not.toHaveBeenCalled()
  expect(state.pending).toBe(pending)
  await expect(reconcilePendingWithdrawal(session)).resolves.toContain('Withdrawal confirmed')
  expect(state.ratchet).toHaveBeenCalledTimes(2)
  expect(state.ratchet).toHaveBeenLastCalledWith(56n, 8)
  expect(state.remove).toHaveBeenCalledOnce()
})
