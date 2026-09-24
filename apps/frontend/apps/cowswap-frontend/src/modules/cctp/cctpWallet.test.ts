import { decodeFunctionData, erc20Abi, getAddress, type WalletClient } from 'viem'

import { cctpClient, readCctpFunds, type CctpQuote } from './cctp.service'
import { cctpAssetRoute, cctpSpender, CROSS_CHAIN_TOKEN_SERVICE } from './cctpAssets.const'
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
  getBlock: jest.fn(),
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
  client.getBlock.mockResolvedValue({ number: 100n, timestamp: BigInt(Math.floor(Date.now() / 1000)) })
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

it('approves the cirBTC manager and pays a separate native Arc fee without treating cirBTC as native USDC', async () => {
  const expanded: CctpQuote = {
    ...quote,
    asset: 'cirBTC',
    destination: 1,
    amount: '100000000',
    maxFee: '0',
    expanded: {
      signedQuote: `0x${'11'.repeat(100)}`,
      feeTotalAmount: '10000000000000000',
      issuedAt: Math.floor(Date.now() / 1000),
      expiry: { mode: 'TIMESTAMP', expiresAt: Math.floor(Date.now() / 1000) + 120 },
    },
  }
  jest.mocked(readCctpFunds).mockResolvedValue({ allowance: 0n, balance: 100000000n })
  await approveCctp(wallet as unknown as WalletClient, expanded)
  expect(decodeFunctionData({ abi: erc20Abi, data: wallet.sendTransaction.mock.calls[0]?.[0].data }).args).toEqual([
    getAddress(cctpSpender('cirBTC')),
    100000000n,
  ])
  jest.mocked(readCctpFunds).mockResolvedValue({ allowance: 100000000n, balance: 100000000n })
  client.getBalance.mockResolvedValue(20000000000000000n)
  await burnCctp(wallet as unknown as WalletClient, expanded, beforeSignature)
  expect(wallet.sendTransaction).toHaveBeenLastCalledWith(
    expect.objectContaining({ to: CROSS_CHAIN_TOKEN_SERVICE, value: 10000000000000000n, nonce: 7 }),
  )
  expect(client.estimateGas).toHaveBeenLastCalledWith(expect.objectContaining({ value: 10000000000000000n }))
  client.getBalance.mockResolvedValueOnce(10000000000000000n)
  await expect(burnCctp(wallet as unknown as WalletClient, expanded, beforeSignature)).rejects.toThrow('gas')
})

it('rejects a non-USDC quote when its source block expiry is reached before signing', async () => {
  const now = Math.floor(Date.now() / 1000)
  const expanded: CctpQuote = {
    ...quote,
    asset: 'EURC',
    maxFee: '0',
    expanded: {
      signedQuote: `0x${'11'.repeat(100)}`,
      feeTotalAmount: '1',
      issuedAt: now,
      expiry: { mode: 'BLOCK_NUMBER', expiresAtBlock: 500, blockEstimatedAt: now + 120 },
    },
  }
  client.getBlock.mockResolvedValueOnce({ number: 500n, timestamp: BigInt(now) })
  await expect(burnCctp(wallet as unknown as WalletClient, expanded, beforeSignature)).rejects.toThrow('expired')
  expect(beforeSignature).not.toHaveBeenCalled()
  expect(wallet.sendTransaction).not.toHaveBeenCalled()
})

it('keeps supported networks and replaces unsupported asset routes with distinct endpoints', () => {
  expect(cctpAssetRoute('cirBTC', 5042, 8453)).toEqual({ source: 5042, destination: 1 })
  expect(cctpAssetRoute('cirBTC', 8453, 1)).toEqual({ source: 5042, destination: 1 })
  expect(cctpAssetRoute('cirBTC', 8453, 5042)).toEqual({ source: 1, destination: 5042 })
  expect(cctpAssetRoute('EURC', 5042, 8453)).toEqual({ source: 5042, destination: 8453 })
})

it.each([-3600000, 3600000])(
  'uses source-chain quote expiry when the browser clock is offset by %s ms',
  async (offset) => {
    const now = Date.now()
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + offset)
    const expanded: CctpQuote = {
      ...quote,
      quotedAt: now + offset,
      asset: 'EURC',
      maxFee: '0',
      expanded: {
        signedQuote: `0x${'11'.repeat(100)}`,
        feeTotalAmount: '1',
        issuedAt: Math.floor(now / 1000),
        expiry: { mode: 'TIMESTAMP', expiresAt: Math.floor(now / 1000) + 120 },
      },
    }
    try {
      await burnCctp(wallet as unknown as WalletClient, expanded, beforeSignature)
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1)
      client.getBlock.mockResolvedValueOnce({ number: 100n, timestamp: BigInt(Math.floor(now / 1000) + 110) })
      await expect(burnCctp(wallet as unknown as WalletClient, expanded, beforeSignature)).rejects.toThrow('expired')
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  },
)
