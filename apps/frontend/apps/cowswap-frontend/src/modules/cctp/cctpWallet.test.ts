import { decodeFunctionData, erc20Abi, type WalletClient } from 'viem'

import { cctpClient, readCctpFunds, type CctpQuote } from './cctp.service'
import { approveCctp, burnCctp, switchCctpChain } from './cctpWallet.service'

jest.mock('./cctp.service', () => ({
  ...jest.requireActual('./cctp.service'),
  cctpClient: jest.fn(),
  readCctpFunds: jest.fn(),
  verifyCctpNetwork: jest.fn().mockResolvedValue(undefined),
}))
const owner = '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A'
const quote: CctpQuote = { source: 5042, destination: 8453, owner, amount: '2000000', maxFee: '15638', quotedAt: 0 }
const client = {
  estimateGas: jest.fn(),
  getGasPrice: jest.fn(),
  getBalance: jest.fn(),
  getCode: jest.fn(),
  getTransactionCount: jest.fn(),
}
const wallet = { getChainId: jest.fn(), getAddresses: jest.fn(), sendTransaction: jest.fn() }
const beforeSignature = jest.fn().mockResolvedValue(undefined)

beforeEach(() => {
  jest.clearAllMocks()
  quote.quotedAt = Date.now()
  jest.mocked(cctpClient).mockReturnValue(client as unknown as ReturnType<typeof cctpClient>)
  jest.mocked(readCctpFunds).mockResolvedValue({ allowance: 2000000n, balance: 2000000n })
  wallet.getChainId.mockResolvedValue(5042)
  wallet.getAddresses.mockResolvedValue([owner])
  wallet.sendTransaction.mockResolvedValue('0x1234')
  client.estimateGas.mockResolvedValue(100000n)
  client.getGasPrice.mockResolvedValue(1000000000n)
  client.getBalance.mockResolvedValue(3n * 10n ** 18n)
  client.getCode.mockResolvedValue('0x')
  client.getTransactionCount.mockResolvedValue(7)
})

it('reserves Arc gas at 18 decimals while burning six-decimal USDC', async () => {
  client.getBalance.mockResolvedValueOnce(2n * 10n ** 18n)
  await expect(burnCctp(wallet as unknown as WalletClient, quote, beforeSignature)).rejects.toThrow('gas')
  expect(beforeSignature).not.toHaveBeenCalled()
  expect(wallet.sendTransaction).not.toHaveBeenCalled()
  await burnCctp(wallet as unknown as WalletClient, quote, beforeSignature)
  expect(beforeSignature).toHaveBeenCalledTimes(1)
  expect(wallet.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ account: owner, value: 0n }))
})

it('rejects changed wallet accounts, expired quotes after preflight, and smart accounts before any burn', async () => {
  wallet.getAddresses
    .mockResolvedValueOnce([owner])
    .mockResolvedValueOnce(['0x0000000000000000000000000000000000000001'])
  await expect(burnCctp(wallet as unknown as WalletClient, quote, beforeSignature)).rejects.toThrow('changed')
  client.getCode.mockResolvedValueOnce('0x1234')
  await expect(burnCctp(wallet as unknown as WalletClient, quote, beforeSignature)).rejects.toThrow('personal wallets')
  client.estimateGas.mockImplementationOnce(async () => {
    quote.quotedAt = Date.now() - 61000
    return 100000n
  })
  await expect(burnCctp(wallet as unknown as WalletClient, quote, beforeSignature)).rejects.toThrow('expired')
  expect(beforeSignature).not.toHaveBeenCalled()
  expect(wallet.sendTransaction).not.toHaveBeenCalled()
})

it('approves only the displayed amount and skips approval when allowance already covers it', async () => {
  expect(await approveCctp(wallet as unknown as WalletClient, quote)).toBeUndefined()
  expect(wallet.sendTransaction).not.toHaveBeenCalled()
  jest.mocked(readCctpFunds).mockResolvedValueOnce({ allowance: 0n, balance: 2000000n })
  await approveCctp(wallet as unknown as WalletClient, quote)
  const data = wallet.sendTransaction.mock.calls[0]?.[0].data
  const decoded = decodeFunctionData({ abi: erc20Abi, data })
  expect(decoded.functionName).toBe('approve')
  expect(decoded.args).toEqual(['0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', 2000000n])
})

it('adds a missing Arc network with native USDC metadata but never retries a rejected switch', async () => {
  const switching = {
    switchChain: jest.fn().mockRejectedValueOnce({ code: 4902 }).mockResolvedValue(undefined),
    addChain: jest.fn().mockResolvedValue(undefined),
  }
  await switchCctpChain(switching as unknown as WalletClient, 5042)
  expect(switching.addChain).toHaveBeenCalledWith({
    chain: expect.objectContaining({
      id: 5042,
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
    }),
  })
  expect(switching.switchChain).toHaveBeenCalledTimes(2)
  switching.switchChain.mockRejectedValueOnce({ code: 4001 })
  await expect(switchCctpChain(switching as unknown as WalletClient, 5042)).rejects.toEqual({ code: 4001 })
  expect(switching.addChain).toHaveBeenCalledTimes(1)
})
