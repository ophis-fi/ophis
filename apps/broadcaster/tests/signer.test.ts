import { expect, it, vi } from 'vitest'
import { Wallet, type TransactionLike } from 'ethers'
import { signApprovedTransaction } from '../src/signer'

async function fixture(type: 1 | 2 | 4 = 4) {
  const operator = new Wallet(Wallet.createRandom().privateKey)
  const user = Wallet.createRandom()
  const transaction = { to: user.address, value: 0n, data: '0x1234', chainId: 1n, type, nonce: 7, gasLimit: 100_000n,
    ...(type === 1 ? { gasPrice: 100n } : { maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }),
    ...(type === 4 ? { authorizationList: [await user.authorize({ address: operator.address, chainId: 1, nonce: 0 })] } : {}),
  }
  return { operator, transaction }
}

it.each([1, 2, 4] as const)('accepts an exact signed type-%s transaction through a key-independent interface', async (type) => {
  const { operator, transaction } = await fixture(type)
  const sign = vi.fn((request) => operator.signTransaction(request))
  expect(await signApprovedTransaction({ address: operator.address, signTransaction: sign }, transaction))
    .toBe(await operator.signTransaction(transaction))
  expect(sign).toHaveBeenCalledOnce()
})

it.each(['to', 'value', 'data', 'chainId', 'nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'authorizationList'])(
  'rejects a signer changing %s after admission', async (field) => {
    const { operator, transaction } = await fixture()
    const changes: Record<string, unknown> = { to: operator.address, value: 1n, data: '0xabcd', chainId: 2n, nonce: 8,
      gasLimit: 100_001n, maxFeePerGas: 101n, maxPriorityFeePerGas: 2n, authorizationList: [] }
    const signer = { address: operator.address,
      signTransaction: async () => operator.signTransaction({ ...transaction, [field]: changes[field] }) }
    await expect(signApprovedTransaction(signer, transaction)).rejects.toThrow('different from the approved execution')
  },
)

it('rejects another signing key even when the transaction body is identical', async () => {
  const { operator, transaction } = await fixture()
  const wrong = Wallet.createRandom()
  await expect(signApprovedTransaction({ address: operator.address, signTransaction: (tx) => wrong.signTransaction(tx) }, transaction))
    .rejects.toThrow('different from the approved execution')
})

it('rejects a mismatched requested sender before asking for any signature', async () => {
  const { operator, transaction } = await fixture()
  const signTransaction = vi.fn()
  await expect(signApprovedTransaction({ address: operator.address, signTransaction },
    { ...transaction, from: Wallet.createRandom().address })).rejects.toThrow('approved sender')
  expect(signTransaction).not.toHaveBeenCalled()
})

it('captures the approved body before an adapter can mutate its input', async () => {
  const { operator, transaction } = await fixture()
  const signer = { address: operator.address, signTransaction: async (tx: TransactionLike<string>) => {
    tx.gasLimit = 200_000n
    return operator.signTransaction(tx)
  } }
  await expect(signApprovedTransaction(signer, transaction)).rejects.toThrow('different from the approved execution')
})
