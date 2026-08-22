import { JsonRpcProvider } from '@ethersproject/providers'

import {
  toOtcLegacyForkClients,
  toOtcWalletSubmitter,
  verifyOtcLocalForkProvider,
  verifyOtcLocalForkWallet,
} from './otcWriteAdapters'
import { readOtcAllowance } from './readOtcAllowance'

import type { OtcTransactionRequest } from './otcWrite.types'
import type { Hex } from 'viem'

const ACCOUNT = '0x1111111111111111111111111111111111111111'
const TO = '0x2222222222222222222222222222222222222222'
const TOKEN_WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' // gitleaks:allow — public mainnet address
const HASH: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const forkIt = process.env.OTC_BROWSER_FORK_RPC ? it : it.skip

type Wallet = Parameters<typeof verifyOtcLocalForkWallet>[0]
type Public = Parameters<typeof toOtcWalletSubmitter>[1]
type LegacyProvider = Parameters<typeof verifyOtcLocalForkProvider>[0]

function wallet(version: string, chainId = 1): Wallet {
  return {
    account: { address: ACCOUNT },
    getChainId: async () => chainId,
    request: async ({ method }: { method: string }) => {
      if (method === 'web3_clientVersion') return version
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

function request(): OtcTransactionRequest {
  return { kind: 'cancel', chainId: 1, account: ACCOUNT, to: TO, data: '0x514fcac7', value: 0n }
}

function legacyProvider(version: string, chainId = 1): { provider: LegacyProvider; sendTransaction: jest.Mock } {
  const sendTransaction = jest.fn(async () => ({ hash: HASH }))
  const provider = {
    getNetwork: async () => ({ chainId }),
    send: async (method: string) => {
      if (method === 'web3_clientVersion') return version
      throw new Error(`unexpected ${method}`)
    },
    getSigner: () => ({ getAddress: async () => ACCOUNT, sendTransaction }),
    waitForTransaction: async () => ({ transactionHash: HASH, status: 1, blockNumber: 12 }),
  } as unknown as LegacyProvider
  return { provider, sendTransaction }
}

describe('OTC wallet transport boundary', () => {
  it('recognizes chain-id-1 Anvil and Hardhat transports only', async () => {
    await expect(verifyOtcLocalForkWallet(wallet('anvil/v1.5.0'))).resolves.toBe(true)
    await expect(verifyOtcLocalForkWallet(wallet('HardhatNetwork/2.22.0'))).resolves.toBe(true)
    await expect(verifyOtcLocalForkWallet(wallet('Geth/v1.16.2'))).resolves.toBe(false)
    await expect(verifyOtcLocalForkWallet(wallet('anvil/v1.5.0', 31337))).resolves.toBe(false)
  })

  it('blocks a real-mainnet client before its send method is called', async () => {
    const realMainnet = wallet('Geth/v1.16.2')
    const submitter = toOtcWalletSubmitter(realMainnet, publicClient())
    await expect(submitter.sendTransaction(request())).rejects.toThrow('Ophis OTC local fork verification failed')
    expect(realMainnet.sendTransaction).not.toHaveBeenCalled()
  })

  it('submits through a verified local fork and maps its receipt', async () => {
    const anvil = wallet('anvil/v1.5.0')
    const submitter = toOtcWalletSubmitter(anvil, publicClient())
    await expect(submitter.sendTransaction(request())).resolves.toBe(HASH)
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
    await expect(clients.wallet.sendTransaction(request())).resolves.toBe(HASH)
    expect(anvil.sendTransaction).toHaveBeenCalledTimes(1)
    await expect(clients.wallet.waitForTransactionReceipt(HASH)).resolves.toEqual({
      transactionHash: HASH,
      status: 'success',
      blockNumber: 12n,
    })
  })

  forkIt('reads allowance through a real legacy provider on the browser fork', async () => {
    const rpcUrl = process.env.OTC_BROWSER_FORK_RPC
    if (!rpcUrl) throw new Error('OTC_BROWSER_FORK_RPC missing')
    const provider = new JsonRpcProvider(rpcUrl) as unknown as LegacyProvider
    const clients = toOtcLegacyForkClients(provider, ACCOUNT)

    await expect(readOtcAllowance(clients.writeClient, TOKEN_WETH, ACCOUNT)).resolves.toMatchObject({ allowance: 0n })
  })
})
