/** @jest-environment node */
import { Transaction } from '@mysten/sui/transactions'
import { toBase58 } from '@mysten/sui/utils'

import fixture from './fixtures/suiDeposit.json'
import { nearTransferSchema } from './nearDirect.schemas'
import { StandardConnection } from './standardWallet.atoms'
import { fundSuiTransfer, suiDepositTransaction } from './suiWallet.service'

const mockTransfer = nearTransferSchema.parse(fixture)
const mockSign = jest.fn()
const account = {
  address: fixture.response.quoteRequest.refundTo,
  publicKey: new Uint8Array(32),
  chains: ['sui:mainnet'] as const,
  features: ['sui:signAndExecuteTransaction'] as const,
}
const connection: StandardConnection = {
  account,
  wallet: {
    version: '1.0.0',
    name: 'Test',
    icon: 'data:image/png;base64,',
    chains: account.chains,
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:events': { version: '1.0.0', on: () => () => undefined },
      'sui:signAndExecuteTransaction': { version: '2.0.0', signAndExecuteTransaction: mockSign },
    },
  },
}
jest.mock('./nearDirect.service', () => ({
  ...jest.requireActual('./nearDirect.service'),
  getNearTokens: async () => [mockTransfer.source, mockTransfer.destination],
  getNearTransferStatus: async () => ({ status: 'PENDING_DEPOSIT' }),
}))

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.response.timestamp))
  mockSign.mockReset().mockResolvedValue({ digest: toBase58(new Uint8Array(32).fill(1)) })
})
afterEach(() => jest.restoreAllMocks())

it('creates an exact native/token coin transfer to the quoted deposit', () => {
  for (const contractAddress of [
    undefined,
    '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  ]) {
    const tx = suiDepositTransaction({ ...mockTransfer, source: { ...mockTransfer.source, contractAddress } })
    const data = tx.getData()
    expect(data.sender).toBe(account.address)
    const commands = JSON.stringify(data.commands, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    )
    expect(commands).toContain('1000000000')
    expect(commands).toContain(contractAddress ?? 'gas')
    const input = data.inputs.find((entry) => entry.$kind === 'Pure')
    if (!input?.Pure) throw new Error('Missing recipient')
    expect('0x' + Buffer.from(input.Pure.bytes, 'base64').toString('hex')).toBe(fixture.response.quote.depositAddress)
    expect(data.commands.at(-1)?.$kind).toBe('TransferObjects')
  }
})

it('prepares before journaling, signs on mainnet only afterwards, and stops on storage failure', async () => {
  const build = jest.spyOn(Transaction.prototype, 'build').mockResolvedValue(new Uint8Array())
  jest.spyOn(Transaction.prototype, 'toJSON').mockResolvedValue('{"prepared":true}')
  const journal = jest.fn(async () => {
    expect(build).toHaveBeenCalled()
    expect(mockSign).not.toHaveBeenCalled()
  })
  await fundSuiTransfer(connection, mockTransfer, journal)
  expect(mockSign.mock.calls[0][0].chain).toBe('sui:mainnet')
  expect(await mockSign.mock.calls[0][0].transaction.toJSON()).toBe('{"prepared":true}')
  mockSign.mockClear()
  await expect(
    fundSuiTransfer(connection, mockTransfer, async () => {
      throw new Error('storage full')
    }),
  ).rejects.toThrow('storage full')
  expect(mockSign).not.toHaveBeenCalled()
})

it('rejects stale accounts, forged quotes and amounts that overflow u64', async () => {
  const changed = { ...connection, wallet: { ...connection.wallet, accounts: [] } }
  await expect(fundSuiTransfer(changed, mockTransfer, jest.fn())).rejects.toThrow('refund wallet')
  await expect(
    fundSuiTransfer(
      connection,
      { ...mockTransfer, response: { ...mockTransfer.response, signature: 'forged' } },
      jest.fn(),
    ),
  ).rejects.toThrow('signature')
  expect(() =>
    suiDepositTransaction({
      ...mockTransfer,
      response: {
        ...mockTransfer.response,
        quote: { ...mockTransfer.response.quote, amountIn: '18446744073709551616' },
      },
    }),
  ).toThrow('limits')
  expect(mockSign).not.toHaveBeenCalled()
})
