import { JsonRpcProvider } from '@ethersproject/providers'

import { buildOtcCancelTransaction, buildOtcFillApproval } from './buildOtcTransaction'
import {
  getOtcProviderForkId,
  getOtcWalletForkId,
  toOtcLegacyForkClients,
  toOtcWalletSubmitter,
  verifyOtcLocalForkProvider,
  verifyOtcLocalForkWallet,
} from './otcWriteAdapters'
import { readOtcAllowance } from './readOtcAllowance'

import type { OtcCancelIntent, OtcTransactionRequest } from './otcWrite.types'
import type { OtcOrder } from 'ophis/otc'
import type { Hex } from 'viem'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const TOKEN_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' // gitleaks:allow — public mainnet address
const HASH: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FORK_ID: Hex = `0x${'ab'.repeat(32)}`
const NOW = 1_800_000_000n
const forkIt = process.env.OTC_BROWSER_FORK_RPC ? it : it.skip

type Wallet = Parameters<typeof verifyOtcLocalForkWallet>[0]
type Public = Parameters<typeof toOtcWalletSubmitter>[1]
type LegacyProvider = Parameters<typeof verifyOtcLocalForkProvider>[0]

function wallet(version: string, chainId = 1, activeAccount = ACCOUNT): Wallet {
  return {
    account: { address: ACCOUNT },
    getChainId: async () => chainId,
    request: async ({ method }: { method: string }) => {
      if (method === 'web3_clientVersion') return version
      if (method === 'hardhat_metadata') return { instanceId: FORK_ID, chainId, clientVersion: version }
      if (method === 'eth_accounts') return [activeAccount]
      throw new Error(`unexpected ${method}`)
    },
    sendTransaction: jest.fn(async () => HASH),
  } as unknown as Wallet
}

function publicClient(): Public {
  return {
    waitForTransactionReceipt: async () => ({ transactionHash: HASH, status: 'success', blockNumber: 12n }),
  } as unknown as Public
}

function order(overrides: Partial<OtcOrder> = {}): OtcOrder {
  return {
    orderId: 7n,
    maker: ACCOUNT,
    active: true,
    tokenA: TOKEN_WETH,
    amountA: 1n,
    tokenB: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountB: 2n,
    ...overrides,
  }
}

function transaction(): { intent: OtcCancelIntent; request: OtcTransactionRequest } {
  const intent: OtcCancelIntent = { kind: 'cancel', account: ACCOUNT, order: order() }
  return { intent, request: buildOtcCancelTransaction(intent) }
}

function legacyProvider(
  version: string,
  chainId = 1,
  activeAccount = ACCOUNT,
): { provider: LegacyProvider; sendTransaction: jest.Mock; waitForTransaction: jest.Mock } {
  const sendTransaction = jest.fn(async () => ({ hash: HASH }))
  const waitForTransaction = jest.fn(async () => ({ transactionHash: HASH, status: 1, blockNumber: 12 }))
  const provider = {
    getNetwork: async () => ({ chainId }),
    send: async (method: string) => {
      if (method === 'web3_clientVersion') return version
      if (method === 'hardhat_metadata') return { instanceId: FORK_ID, chainId, clientVersion: version }
      throw new Error(`unexpected ${method}`)
    },
    listAccounts: async () => [activeAccount],
    getSigner: () => ({ getAddress: async () => ACCOUNT, sendTransaction }),
    waitForTransaction,
  } as unknown as LegacyProvider
  return { provider, sendTransaction, waitForTransaction }
}

describe('OTC wallet transport boundary', () => {
  it('recognizes chain-id-1 Anvil and Hardhat transports only', async () => {
    await expect(verifyOtcLocalForkWallet(wallet('anvil/v1.5.0'))).resolves.toBe(true)
    await expect(verifyOtcLocalForkWallet(wallet('HardhatNetwork/2.22.0'))).resolves.toBe(true)
    await expect(verifyOtcLocalForkWallet(wallet('Geth/v1.16.2'))).resolves.toBe(false)
    await expect(verifyOtcLocalForkWallet(wallet('anvil/v1.5.0', 31337))).resolves.toBe(false)
  })

  it('uses a stable node instance ID and rejects a different fork before either signer', async () => {
    const anvil = wallet('anvil/v1.5.1')
    const legacy = legacyProvider('anvil/v1.5.1')
    await expect(getOtcWalletForkId(anvil)).resolves.toBe(FORK_ID)
    await expect(getOtcProviderForkId(legacy.provider)).resolves.toBe(FORK_ID)
    await expect(getOtcWalletForkId(wallet('Geth/v1.16.2'))).rejects.toThrow('fork identity unavailable')
    const otherFork: Hex = `0x${'cd'.repeat(32)}`
    const { request, intent } = transaction()
    await expect(
      toOtcWalletSubmitter(anvil, publicClient(), otherFork).sendTransaction(request, intent, NOW),
    ).rejects.toThrow('local fork changed')
    await expect(
      toOtcLegacyForkClients(legacy.provider, ACCOUNT, otherFork).wallet.sendTransaction(request, intent, NOW),
    ).rejects.toThrow('local fork changed')
    expect(anvil.sendTransaction).not.toHaveBeenCalled()
    expect(legacy.sendTransaction).not.toHaveBeenCalled()
  })

  it.each(['repriced', 'cancelled', 'replaced'] as const)(
    'accepts only an identical repriced receipt: %s',
    async (reason) => {
      const replacementHash: Hex = `0x${'cd'.repeat(32)}`
      const client = publicClient()
      client.waitForTransactionReceipt = jest.fn(async ({ onReplaced }) => {
        onReplaced?.({
          reason,
          replacedTransaction: { hash: HASH },
          transaction: { hash: replacementHash },
        } as Parameters<NonNullable<typeof onReplaced>>[0])
        return { transactionHash: replacementHash, status: 'success', blockNumber: 12n } as Awaited<
          ReturnType<Public['waitForTransactionReceipt']>
        >
      })
      const receipt = toOtcWalletSubmitter(wallet('anvil/v1.5.1'), client).waitForTransactionReceipt(HASH)
      if (reason === 'repriced') {
        await expect(receipt).resolves.toMatchObject({
          transactionHash: replacementHash,
          replacedTransactionHash: HASH,
        })
      } else {
        await expect(receipt).rejects.toThrow('transaction was replaced')
      }
    },
  )

  it('blocks a real-mainnet client before its send method is called', async () => {
    const realMainnet = wallet('Geth/v1.16.2')
    const submitter = toOtcWalletSubmitter(realMainnet, publicClient())
    const { request, intent } = transaction()
    await expect(submitter.sendTransaction(request, intent, NOW)).rejects.toThrow(
      'Ophis OTC local fork verification failed',
    )
    expect(realMainnet.sendTransaction).not.toHaveBeenCalled()
  })

  it('revalidates target, selector, and zero value at the final wallet boundary', async () => {
    const anvil = wallet('anvil/v1.5.0')
    const submitter = toOtcWalletSubmitter(anvil, publicClient())
    const { request, intent } = transaction()
    const invalid = { ...request, value: 1n } as unknown as OtcTransactionRequest
    await expect(submitter.sendTransaction(invalid, intent, NOW)).rejects.toThrow('native value is disabled')
    expect(anvil.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects an otherwise valid approval when it differs from the reviewed intent', async () => {
    const anvil = wallet('anvil/v1.5.0')
    const submitter = toOtcWalletSubmitter(anvil, publicClient())
    const intent = { kind: 'approve-fill' as const, account: ACCOUNT, order: order() }
    const altered = buildOtcFillApproval({ ...intent, order: order({ amountB: 3n }) })

    await expect(submitter.sendTransaction(altered, intent, NOW)).rejects.toThrow(
      'request differs from reviewed intent',
    )
    expect(anvil.sendTransaction).not.toHaveBeenCalled()
  })

  it('rejects account drift reported by the wallet after fork verification', async () => {
    const changedAccount = '0x2222222222222222222222222222222222222222'
    const anvil = wallet('anvil/v1.5.0', 1, changedAccount)
    const submitter = toOtcWalletSubmitter(anvil, publicClient())
    const legacy = legacyProvider('anvil/v1.5.0', 1, changedAccount)
    const legacySubmitter = toOtcLegacyForkClients(legacy.provider, ACCOUNT).wallet
    const { request, intent } = transaction()

    await expect(submitter.sendTransaction(request, intent, NOW)).rejects.toThrow('wallet account changed')
    await expect(legacySubmitter.sendTransaction(request, intent, NOW)).rejects.toThrow('wallet account changed')
    expect(anvil.sendTransaction).not.toHaveBeenCalled()
    expect(legacy.sendTransaction).not.toHaveBeenCalled()
  })

  it('rechecks the action context at both final signer boundaries', async () => {
    const anvil = wallet('anvil/v1.5.0')
    const submitter = toOtcWalletSubmitter(anvil, publicClient())
    const legacy = legacyProvider('anvil/v1.5.0')
    const legacySubmitter = toOtcLegacyForkClients(legacy.provider, ACCOUNT).wallet
    const { request, intent } = transaction()

    await expect(submitter.sendTransaction(request, intent, NOW, () => false)).rejects.toThrow('action context changed')
    await expect(legacySubmitter.sendTransaction(request, intent, NOW, () => false)).rejects.toThrow(
      'action context changed',
    )
    expect(anvil.sendTransaction).not.toHaveBeenCalled()
    expect(legacy.sendTransaction).not.toHaveBeenCalled()
  })

  it('submits through a verified local fork and maps its receipt', async () => {
    const anvil = wallet('anvil/v1.5.0')
    const submitter = toOtcWalletSubmitter(anvil, publicClient())
    const { request, intent } = transaction()
    await expect(submitter.sendTransaction(request, intent, NOW)).resolves.toBe(HASH)
    await expect(submitter.waitForTransactionReceipt(HASH)).resolves.toEqual({
      transactionHash: HASH,
      status: 'success',
      blockNumber: 12n,
    })
  })

  it('keeps the legacy connector behind the same fork, account, and receipt checks', async () => {
    const anvil = legacyProvider('anvil/v1.5.0')
    const geth = legacyProvider('Geth/v1.16.2')

    await expect(verifyOtcLocalForkProvider(anvil.provider)).resolves.toBe(true)
    await expect(verifyOtcLocalForkProvider(geth.provider)).resolves.toBe(false)
    const clients = toOtcLegacyForkClients(anvil.provider, ACCOUNT)
    const { request, intent } = transaction()
    await expect(clients.wallet.sendTransaction(request, intent, NOW)).resolves.toBe(HASH)
    expect(anvil.sendTransaction).toHaveBeenCalledTimes(1)
    await expect(clients.wallet.waitForTransactionReceipt(HASH)).resolves.toEqual({
      transactionHash: HASH,
      status: 'success',
      blockNumber: 12n,
    })
    expect(anvil.waitForTransaction).toHaveBeenCalledWith(HASH, 1, 120_000)
  })

  forkIt('reads allowance through a real legacy provider on the browser fork', async () => {
    const rpcUrl = process.env.OTC_BROWSER_FORK_RPC
    if (!rpcUrl) throw new Error('OTC_BROWSER_FORK_RPC missing')
    const provider = new JsonRpcProvider(rpcUrl) as unknown as LegacyProvider
    const clients = toOtcLegacyForkClients(provider, ACCOUNT)

    await expect(readOtcAllowance(clients.writeClient, TOKEN_WETH, ACCOUNT)).resolves.toMatchObject({ allowance: 0n })
  })
})
