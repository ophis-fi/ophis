/** @jest-environment node */
import { TronWeb, utils } from 'tronweb'
import { UserRejectedRequestError } from 'viem'

import fixture from './fixtures/tronDeposit.json'
import { nearTransferSchema } from './nearDirect.schemas'
import { TronConnection } from './tronWallet.atoms'
import { assertTronDepositTransaction, fundTronTransfer, tronDepositTransaction } from './tronWallet.service'

const mockTransfer = nearTransferSchema.parse(fixture)
const web = new TronWeb({ fullHost: 'https://api.trongrid.io' })
const connection: TronConnection = {
  address: fixture.response.quoteRequest.refundTo,
  name: 'TronLink',
  provider: { tronWeb: web, request: jest.fn(), on: jest.fn(), removeListener: jest.fn() },
}
jest.mock('./nearDirect.service', () => ({
  ...jest.requireActual('./nearDirect.service'),
  getNearTokens: async () => [mockTransfer.source, mockTransfer.destination],
  getNearTransferStatus: async () => ({ status: 'PENDING_DEPOSIT' }),
}))

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.response.timestamp))
  web.setAddress(connection.address)
  jest
    .spyOn(web.trx, 'getBlock')
    .mockResolvedValue({ blockID: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc' } as Awaited<
      ReturnType<typeof web.trx.getBlock>
    >)
  jest.spyOn(web.trx, 'getCurrentRefBlockParams').mockResolvedValue({
    ref_block_bytes: '1234',
    ref_block_hash: '12'.repeat(8),
    expiration: Date.now() + 60_000,
    timestamp: Date.now(),
  })
})
afterEach(() => jest.restoreAllMocks())

it('builds and signs exact TRX after journaling, then broadcasts the same transaction', async () => {
  const sign = jest.spyOn(web.trx, 'sign').mockImplementation(async (tx) => {
    if (typeof tx === 'string') throw new Error('Expected transaction')
    return { ...tx, signature: ['01'.repeat(65)] }
  })
  const broadcast = jest
    .spyOn(web.trx, 'sendRawTransaction')
    .mockImplementation(async (tx) => ({ result: true, txid: tx.txID, transaction: tx, code: 'SUCCESS', message: '' }))
  const journal = jest.fn(async () => {
    expect(sign).not.toHaveBeenCalled()
  })
  const hash = await fundTronTransfer(connection, mockTransfer, journal)
  expect(journal).toHaveBeenCalledTimes(1)
  expect(broadcast).toHaveBeenCalledTimes(1)
  const signedInput = sign.mock.calls[0][0]
  if (typeof signedInput === 'string') throw new Error('Expected transaction')
  expect(signedInput.raw_data.contract[0].parameter.value).toEqual({
    owner_address: TronWeb.address.toHex(connection.address),
    to_address: TronWeb.address.toHex(String(fixture.response.quote.depositAddress)),
    amount: 1000000000,
  })
  expect(hash).toBe(broadcast.mock.calls[0][0].txID)
})

it('verifies TRC20 recipient/amount and rejects a validly serialized transaction for a different deposit', async () => {
  const transfer = {
    ...mockTransfer,
    source: { ...mockTransfer.source, contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
  }
  // SDK builds the contract call locally; no RPC or signature is used.
  const tx = await tronDepositTransaction(web, transfer)
  expect(() => assertTronDepositTransaction(tx, transfer)).not.toThrow()
  const value = tx.raw_data.contract[0].parameter.value
  if (!('data' in value)) throw new Error('Missing token call')
  expect(value.data).toBe(
    'a9059cbb' +
      utils.abi
        .encodeParams(['address', 'uint256'], [String(transfer.response.quote.depositAddress), '1000000000'])
        .slice(2),
  )
  expect(() =>
    assertTronDepositTransaction(tx, {
      ...transfer,
      response: { ...transfer.response, quote: { ...transfer.response.quote, amountIn: '1000000001' } },
    }),
  ).toThrow()
})

it('does not broadcast rejected approvals, and keeps unknown failures distinct', async () => {
  const sign = jest
    .spyOn(web.trx, 'sign')
    .mockRejectedValueOnce(new Error('Confirmation declined by user'))
    .mockRejectedValueOnce(new Error('connection lost'))
  const broadcast = jest.spyOn(web.trx, 'sendRawTransaction')
  await expect(fundTronTransfer(connection, mockTransfer, jest.fn())).rejects.toThrow(UserRejectedRequestError)
  await expect(fundTronTransfer(connection, mockTransfer, jest.fn())).rejects.toThrow('connection lost')
  expect(sign).toHaveBeenCalledTimes(2)
  expect(broadcast).not.toHaveBeenCalled()
})
