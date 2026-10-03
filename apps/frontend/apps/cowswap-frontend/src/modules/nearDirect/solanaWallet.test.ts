/** @jest-environment node */
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit'
import { getTransferSolInstructionDataDecoder, SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system'
import { parseTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'

import fixture from './fixtures/solDeposit.json'
import { nearTransferSchema } from './nearDirect.schemas'
import { fundSolanaTransfer, solanaDepositInstructions } from './solanaWallet.service'
import { StandardConnection } from './standardWallet.atoms'

const mockTransfer = nearTransferSchema.parse(fixture)
const mockSign = jest.fn()
const account = {
  address: fixture.response.quoteRequest.refundTo,
  publicKey: new Uint8Array(32),
  chains: ['solana:mainnet'] as const,
  features: ['solana:signAndSendTransaction'] as const,
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
      'solana:signAndSendTransaction': { supportedTransactionVersions: ['legacy'], signAndSendTransaction: mockSign },
    },
  },
}
let mockProgram: string = TOKEN_PROGRAM_ADDRESS
jest.mock('./nearDirect.service', () => ({
  ...jest.requireActual('./nearDirect.service'),
  getNearTokens: async () => [mockTransfer.source, mockTransfer.destination],
  getNearTransferStatus: async () => ({ status: 'PENDING_DEPOSIT' }),
}))
jest.mock('@solana/kit', () => ({
  ...jest.requireActual('@solana/kit'),
  createSolanaRpc: () => ({
    getGenesisHash: () => ({ send: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }),
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 123n } }),
    }),
  }),
}))
jest.mock('@solana-program/token', () => ({
  ...jest.requireActual('@solana-program/token'),
  fetchMint: async () => ({ programAddress: mockProgram, data: { decimals: 6 } }),
}))

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.response.timestamp))
  mockSign.mockReset().mockResolvedValue([{ signature: new Uint8Array(64).fill(1) }])
  mockProgram = TOKEN_PROGRAM_ADDRESS
})
afterEach(() => jest.restoreAllMocks())

it('asks the wallet for the exact native deposit only after persistence', async () => {
  const journal = jest.fn(async () => {
    expect(mockSign).not.toHaveBeenCalled()
  })
  await fundSolanaTransfer(connection, mockTransfer, journal)
  const request = mockSign.mock.calls[0][0]
  const tx = getTransactionDecoder().decode(request.transaction)
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
  const ix = message.instructions[0]
  if (!ix.accountIndices || !ix.data) throw new Error('Missing compiled instruction')
  expect(journal).toHaveBeenCalledTimes(1)
  expect(request.chain).toBe('solana:mainnet')
  expect(message.staticAccounts[ix.programAddressIndex]).toBe(SYSTEM_PROGRAM_ADDRESS)
  expect(ix.accountIndices.map((i) => message.staticAccounts[i])).toEqual([
    account.address,
    fixture.response.quote.depositAddress,
  ])
  expect(getTransferSolInstructionDataDecoder().decode(ix.data).amount).toBe(100000000n)
})

it('creates the receiver ATA and transfers exact SPL units; rejects other token programs', async () => {
  const token = {
    ...mockTransfer,
    source: { ...mockTransfer.source, contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  }
  const instructions = await solanaDepositInstructions(token)
  expect(instructions).toHaveLength(2)
  expect(instructions[0].accounts?.[2].address).toBe(fixture.response.quote.depositAddress)
  const ix = instructions[1]
  if (!ix.accounts || !ix.data) throw new Error('Missing transfer data')
  expect(parseTransferCheckedInstruction({ ...ix, accounts: ix.accounts, data: ix.data }).data).toEqual({
    discriminator: 12,
    amount: 100000000n,
    decimals: 6,
  })
  mockProgram = SYSTEM_PROGRAM_ADDRESS
  await expect(solanaDepositInstructions(token)).rejects.toThrow('token program')
})

it('blocks forged quotes, failed persistence, and a changed wallet before signing', async () => {
  await expect(
    fundSolanaTransfer(
      connection,
      { ...mockTransfer, response: { ...mockTransfer.response, signature: 'forged' } },
      jest.fn(),
    ),
  ).rejects.toThrow('signature')
  await expect(
    fundSolanaTransfer(connection, mockTransfer, async () => {
      throw new Error('storage full')
    }),
  ).rejects.toThrow('storage full')
  const changed = { ...connection, wallet: { ...connection.wallet, accounts: [] } }
  await expect(fundSolanaTransfer(changed, mockTransfer, jest.fn())).rejects.toThrow('refund wallet')
  expect(mockSign).not.toHaveBeenCalled()
})
