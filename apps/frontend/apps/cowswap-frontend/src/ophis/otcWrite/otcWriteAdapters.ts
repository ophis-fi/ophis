import { withTimeout } from '@cowprotocol/common-utils'
import type { Web3Provider } from '@ethersproject/providers'

import { toOtcReaderClient } from 'ophis/otc'
import {
  isAddressEqual,
  publicActions,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from 'viem'
import { mainnet } from 'viem/chains'
import { usePublicClient } from 'wagmi'

import { assertOtcTransactionRequest } from './assertOtcTransactionRequest'
import { OTC_RECEIPT_TIMEOUT_MS, waitForOtcReceipt } from './otcReceiptTracking.utils'

import type { OtcWalletSubmitter, OtcWriteClient } from './otcWrite.types'

type WagmiPublicClient = NonNullable<ReturnType<typeof usePublicClient>>
type WagmiWalletClient = WalletClient<Transport, Chain, Account>

const LOCAL_FORK_CLIENT = /anvil|hardhat/i
const OTC_FORK_ID_TIMEOUT_MS = 10_000

function parseForkId(metadata: unknown): Hex {
  if (!metadata || typeof metadata !== 'object') throw new Error('Ophis OTC fork identity unavailable')
  const { instanceId, chainId, clientVersion } = metadata as Record<string, unknown>
  if (
    chainId !== 1 ||
    typeof clientVersion !== 'string' ||
    !LOCAL_FORK_CLIENT.test(clientVersion) ||
    typeof instanceId !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(instanceId)
  ) {
    throw new Error('Ophis OTC fork identity unavailable')
  }
  return instanceId.toLowerCase() as Hex
}

export async function getOtcWalletForkId(walletClient: WagmiWalletClient): Promise<Hex> {
  const request = walletClient.request as unknown as (request: { method: 'hardhat_metadata' }) => Promise<unknown>
  return parseForkId(
    await withTimeout(
      request({ method: 'hardhat_metadata' }),
      OTC_FORK_ID_TIMEOUT_MS,
      'Ophis OTC fork identity timed out',
    ),
  )
}

export async function getOtcProviderForkId(provider: Web3Provider): Promise<Hex> {
  return parseForkId(
    await withTimeout(
      provider.send('hardhat_metadata', []),
      OTC_FORK_ID_TIMEOUT_MS,
      'Ophis OTC fork identity timed out',
    ),
  )
}

async function assertForkIdentity(readId: () => Promise<Hex>, expectedId?: Hex): Promise<void> {
  if (expectedId && (await readId()) !== expectedId) throw new Error('Ophis OTC local fork changed')
}

function safeBlockNumber(blockNumber: bigint): number {
  const value = Number(blockNumber)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Ophis OTC block number is unsafe')
  return value
}

export async function verifyOtcLocalForkWallet(walletClient: WagmiWalletClient): Promise<boolean> {
  const requestClientVersion = walletClient.request as unknown as (request: {
    method: 'web3_clientVersion'
  }) => Promise<unknown>
  const [chainId, clientVersion] = await Promise.all([
    walletClient.getChainId(),
    requestClientVersion({ method: 'web3_clientVersion' }),
  ])
  return chainId === 1 && typeof clientVersion === 'string' && LOCAL_FORK_CLIENT.test(clientVersion)
}

export async function verifyOtcLocalForkProvider(provider: Web3Provider): Promise<boolean> {
  const [network, clientVersion] = await Promise.all([provider.getNetwork(), provider.send('web3_clientVersion', [])])
  return network.chainId === 1 && typeof clientVersion === 'string' && LOCAL_FORK_CLIENT.test(clientVersion)
}

/** Extends the already-pinned reader adapter with exact eth_call simulation. */
export function toOtcWriteClient(publicClient: WagmiPublicClient): OtcWriteClient {
  return {
    ...toOtcReaderClient(publicClient),
    simulate: async (request, blockNumber) => {
      await publicClient.call({
        account: request.account,
        to: request.to,
        data: request.data,
        value: request.value,
        blockNumber,
      })
    },
  }
}

/**
 * The wallet adapter rejects chain/account drift before asking the connector
 * to sign, then waits for an Ethereum receipt through the pinned public client.
 */
export function toOtcWalletSubmitter(
  walletClient: WagmiWalletClient,
  publicClient: WagmiPublicClient,
  expectedForkId?: Hex,
): OtcWalletSubmitter {
  return {
    sendTransaction: async (request, intent, nowSeconds, isCurrentContext = () => true) => {
      const checkedRequest = Object.freeze({ ...request })
      assertOtcTransactionRequest(checkedRequest, intent, nowSeconds)
      if (!(await verifyOtcLocalForkWallet(walletClient))) throw new Error('Ophis OTC local fork verification failed')
      const [walletChainId, walletAccounts] = await Promise.all([
        walletClient.getChainId(),
        walletClient.request({ method: 'eth_accounts' }),
      ])
      if (walletChainId !== checkedRequest.chainId) throw new Error('Ophis OTC wallet is on the wrong chain')
      const walletAccount = walletAccounts[0]
      const configuredAccount = walletClient.account?.address
      if (
        !walletAccount ||
        !configuredAccount ||
        !isAddressEqual(walletAccount, checkedRequest.account) ||
        !isAddressEqual(configuredAccount, checkedRequest.account)
      ) {
        throw new Error('Ophis OTC wallet account changed')
      }
      await assertForkIdentity(() => getOtcWalletForkId(walletClient), expectedForkId)
      if (!isCurrentContext()) throw new Error('Ophis OTC action context changed')
      return walletClient.sendTransaction({
        account: walletClient.account,
        chain: mainnet,
        to: checkedRequest.to,
        data: checkedRequest.data,
        value: checkedRequest.value,
      })
    },
    waitForTransactionReceipt: async (hash) => {
      await assertForkIdentity(() => getOtcWalletForkId(walletClient), expectedForkId)
      const receipt = await waitForOtcReceipt(publicClient, hash)
      await assertForkIdentity(() => getOtcWalletForkId(walletClient), expectedForkId)
      return receipt
    },
  }
}

/** Build both adapters over the wallet's own transport so preflight and send cannot target different RPCs. */
export function toOtcForkClients(
  walletClient: WagmiWalletClient,
  expectedForkId?: Hex,
): {
  writeClient: OtcWriteClient
  wallet: OtcWalletSubmitter
} {
  const connectedPublicClient = walletClient.extend(publicActions)
  // viem's extended Client has the same public action methods as PublicClient;
  // its intersection type is wider because it also retains wallet actions.
  const publicClient = connectedPublicClient as unknown as WagmiPublicClient
  return {
    writeClient: toOtcWriteClient(publicClient),
    wallet: toOtcWalletSubmitter(walletClient, publicClient, expectedForkId),
  }
}

/** Legacy web3-react adapter; kept narrow while the host app completes its Wagmi migration. */
export function toOtcLegacyForkClients(
  provider: Web3Provider,
  account: Address,
  expectedForkId?: Hex,
): { writeClient: OtcWriteClient; wallet: OtcWalletSubmitter } {
  const writeClient: OtcWriteClient = {
    getChainId: async () => (await provider.getNetwork()).chainId,
    getLatestBlock: async () => {
      const block = await provider.getBlock('latest')
      return { number: BigInt(block.number), hash: block.hash as Hex | null, timestamp: BigInt(block.timestamp) }
    },
    getBlockByNumber: async (blockNumber) => {
      const block = await provider.getBlock(safeBlockNumber(blockNumber))
      return { number: BigInt(block.number), hash: block.hash as Hex | null, timestamp: BigInt(block.timestamp) }
    },
    getCode: async (address, blockNumber) => provider.getCode(address, safeBlockNumber(blockNumber)) as Promise<Hex>,
    call: async (request) => ({
      data: (await provider.call(
        { to: request.to, data: request.data, gasLimit: request.gas },
        safeBlockNumber(request.blockNumber),
      )) as Hex,
    }),
    simulate: async (request, blockNumber) => {
      await provider.call(
        { from: request.account, to: request.to, data: request.data, value: request.value },
        safeBlockNumber(blockNumber),
      )
    },
  }
  const wallet: OtcWalletSubmitter = {
    sendTransaction: async (request, intent, nowSeconds, isCurrentContext = () => true) => {
      const checkedRequest = Object.freeze({ ...request })
      assertOtcTransactionRequest(checkedRequest, intent, nowSeconds)
      if (!isAddressEqual(account, checkedRequest.account)) throw new Error('Ophis OTC wallet account changed')
      if (!(await verifyOtcLocalForkProvider(provider))) throw new Error('Ophis OTC local fork verification failed')
      const [network, providerAccounts] = await Promise.all([provider.getNetwork(), provider.listAccounts()])
      if (network.chainId !== checkedRequest.chainId) throw new Error('Ophis OTC wallet is on the wrong chain')
      const providerAccount = providerAccounts[0]
      if (!providerAccount || !isAddressEqual(providerAccount as Address, checkedRequest.account))
        throw new Error('Ophis OTC wallet account changed')
      const signer = provider.getSigner(providerAccount)
      await assertForkIdentity(() => getOtcProviderForkId(provider), expectedForkId)
      if (!isCurrentContext()) throw new Error('Ophis OTC action context changed')
      const transaction = await signer.sendTransaction({
        to: checkedRequest.to,
        data: checkedRequest.data,
        value: checkedRequest.value,
      })
      return transaction.hash as Hex
    },
    waitForTransactionReceipt: async (hash) => {
      await assertForkIdentity(() => getOtcProviderForkId(provider), expectedForkId)
      const receipt = await provider.waitForTransaction(hash, 1, OTC_RECEIPT_TIMEOUT_MS)
      await assertForkIdentity(() => getOtcProviderForkId(provider), expectedForkId)
      if (!receipt) throw new Error('Ophis OTC transaction receipt unavailable')
      return {
        transactionHash: receipt.transactionHash as Hex,
        status: receipt.status === 1 ? 'success' : 'reverted',
        blockNumber: BigInt(receipt.blockNumber),
      }
    },
  }
  return { writeClient, wallet }
}
