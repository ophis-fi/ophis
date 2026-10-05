import fixture from './fixtures/monadDeposit.json'
import { NearTransfer } from './nearDirect.schemas'
import { getNearTokens, getNearTransferStatus, validateNearTransfer } from './nearDirect.service'
import {
  fundNearStarknetTransfer,
  getStarknetAccount,
  StarknetUserRejectedError,
  StarknetWalletChangedError,
  StarknetWallet,
} from './starknetWallet.service'

jest.mock('./nearDirect.service', () => ({
  validateNearTransfer: jest.fn(),
  getNearTokens: jest.fn(),
  getNearTransferStatus: jest.fn(),
  hasCurrentNearAssets: (transfer: NearTransfer, tokens: unknown[]) => tokens.includes(transfer.source),
  getNearFundingDeadline: () => Date.now() + 120_000,
}))
const account = '0x01' + '11'.repeat(31)
const deposit = '0x02' + '22'.repeat(31)
const strk = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
const hash = '0x03' + '33'.repeat(31)
const request = jest.fn()
const events = new Map<string, () => void>()
const wallet = {
  request,
  on: (event: string, handler: () => void) => events.set(event, handler),
  off: (event: string) => events.delete(event),
} as unknown as StarknetWallet
let transfer: NearTransfer
let journal: jest.Mock

beforeEach(() => {
  jest.resetAllMocks()
  transfer = {
    ...fixture,
    source: { assetId: 'nep141:starknet.omft.near', blockchain: 'starknet', decimals: 18, symbol: 'STRK', price: 0.05 },
    response: {
      ...fixture.response,
      quote: { ...fixture.response.quote, amountIn: '90000000000000000000', depositAddress: deposit },
      quoteRequest: { ...fixture.response.quoteRequest, refundTo: account },
    },
  } as NearTransfer
  jest.mocked(getNearTokens).mockResolvedValue([transfer.source, transfer.destination])
  jest.mocked(getNearTransferStatus).mockResolvedValue(transfer)
  journal = jest.fn().mockResolvedValue(undefined)
  request.mockImplementation(async ({ type }: { type: string }) => {
    if (type === 'wallet_requestAccounts') return [account]
    if (type === 'wallet_requestChainId') return '0x534e5f4d41494e'
    expect(journal).toHaveBeenCalledTimes(1)
    return { transaction_hash: hash }
  })
})

it('sends native STRK through its canonical ERC20 contract after saving recovery', async () => {
  await expect(fundNearStarknetTransfer(wallet, transfer, journal)).resolves.toBe(hash)
  expect(validateNearTransfer).toHaveBeenCalledWith(transfer)
  expect(request).toHaveBeenLastCalledWith({
    type: 'wallet_addInvokeTransaction',
    params: {
      calls: [
        {
          contract_address: strk,
          entry_point: 'transfer',
          calldata: [deposit, '0x4e1003b28d9280000', '0x0'],
        },
      ],
    },
  })
})

it('preserves the high half and low bits of uint256 token amounts', async () => {
  transfer.source.contractAddress = strk
  transfer.response.quote.amountIn = ((1n << 128n) + 7n).toString()
  await fundNearStarknetTransfer(wallet, transfer, journal)
  expect(request.mock.calls.at(-1)?.[0].params.calls[0].calldata).toEqual([deposit, '0x7', '0x1'])
})

it.each(['fundingStarted', 'transactionHash'] as const)('blocks a previously funded quote (%s)', async (field) => {
  if (field === 'fundingStarted') transfer.fundingStarted = true
  else transfer.transactionHash = hash
  await expect(fundNearStarknetTransfer(wallet, transfer, journal)).rejects.toThrow('already have been sent')
  expect(journal).not.toHaveBeenCalled()
})

it.each(['stale assets', 'detected deposit', 'bad signature', 'unknown native token', 'oversized uint256'])(
  'fails closed on %s',
  async (reason) => {
    if (reason === 'stale assets') jest.mocked(getNearTokens).mockResolvedValue([])
    if (reason === 'detected deposit')
      jest.mocked(getNearTransferStatus).mockResolvedValue({ ...transfer, status: 'PROCESSING' })
    if (reason === 'bad signature')
      jest.mocked(validateNearTransfer).mockImplementation(() => {
        throw new Error('signature')
      })
    if (reason === 'unknown native token') transfer.source.assetId = 'unexpected'
    if (reason === 'oversized uint256') transfer.response.quote.amountIn = (1n << 256n).toString()
    await expect(fundNearStarknetTransfer(wallet, transfer, journal)).rejects.toThrow()
    expect(journal).not.toHaveBeenCalled()
    expect(request.mock.calls.some(([call]) => call.type === 'wallet_addInvokeTransaction')).toBe(false)
  },
)

it.each(['network', 'account'])('blocks %s changes while saving the funding journal', async (change) => {
  journal.mockImplementation(async () => {
    request.mockImplementation(async ({ type }: { type: string }) =>
      type === 'wallet_requestAccounts' ? [change === 'account' ? deposit : account] : '0x534e5f5345504f4c4941',
    )
  })
  await expect(fundNearStarknetTransfer(wallet, transfer, journal)).rejects.toThrow()
  expect(request.mock.calls.some(([call]) => call.type === 'wallet_addInvokeTransaction')).toBe(false)
})

it('does not prompt for a transaction if recovery cannot be saved', async () => {
  journal.mockRejectedValue(new Error('storage full'))
  await expect(fundNearStarknetTransfer(wallet, transfer, journal)).rejects.toThrow('storage full')
  expect(request.mock.calls.some(([call]) => call.type === 'wallet_addInvokeTransaction')).toBe(false)
})

it.each([113, 163])('distinguishes explicit wallet refusal from uncertain transport error (%s)', async (code) => {
  request.mockImplementation(async ({ type }: { type: string }) => {
    if (type === 'wallet_requestAccounts') return [account]
    if (type === 'wallet_requestChainId') return '0x534e5f4d41494e'
    throw { code }
  })
  const failure = await fundNearStarknetTransfer(wallet, transfer, journal).catch((error: unknown) => error)
  expect(failure instanceof StarknetUserRejectedError).toBe(code === 113)
})

it('rejects testnet connections before accepting a refund account', async () => {
  request.mockResolvedValueOnce([account]).mockResolvedValueOnce('0x534e5f5345504f4c4941')
  await expect(getStarknetAccount(wallet)).rejects.toThrow('Mainnet')
})

it('accepts a zero-padded representation of the same Starknet account', async () => {
  transfer.response.quoteRequest.refundTo = '0x' + BigInt(account).toString(16)
  await expect(fundNearStarknetTransfer(wallet, transfer, journal)).resolves.toBe(hash)
})

it('aborts before invoke if the account changes during the final chain read', async () => {
  let chainReads = 0
  request.mockImplementation(async ({ type }: { type: string }) => {
    if (type === 'wallet_requestAccounts') return [account]
    if (type === 'wallet_requestChainId') {
      if (++chainReads === 2) events.get('accountsChanged')?.()
      return '0x534e5f4d41494e'
    }
    throw new Error('must not invoke')
  })
  await expect(fundNearStarknetTransfer(wallet, transfer, journal)).rejects.toThrow('changed')
  expect(request.mock.calls.some(([call]) => call.type === 'wallet_addInvokeTransaction')).toBe(false)
  expect(events.size).toBe(0)
})

it.each(['accountsChanged', 'networkChanged'])('preserves the hash if %s fires during approval', async (event) => {
  request.mockImplementation(async ({ type }: { type: string }) => {
    if (type === 'wallet_requestAccounts') return [account]
    if (type === 'wallet_requestChainId') return '0x534e5f4d41494e'
    events.get(event)?.()
    return { transaction_hash: hash }
  })
  const failure = await fundNearStarknetTransfer(wallet, transfer, journal).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(StarknetWalletChangedError)
  expect(failure).toMatchObject({ transactionHash: hash })
  expect(events.size).toBe(0)
})
