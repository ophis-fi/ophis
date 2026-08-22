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

import type { OtcWalletSubmitter, OtcWriteClient } from './otcWrite.types'

type WagmiPublicClient = NonNullable<ReturnType<typeof usePublicClient>>
type WagmiWalletClient = WalletClient<Transport, Chain, Account>

const LOCAL_FORK_CLIENT = /anvil|hardhat/i

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
): OtcWalletSubmitter {
  return {
    sendTransaction: async (request, intent, nowSeconds) => {
      const checkedRequest = Object.freeze({ ...request })
      assertOtcTransactionRequest(checkedRequest, intent, nowSeconds)
      if (!(await verifyOtcLocalForkWallet(walletClient))) throw new Error('Ophis OTC local fork verification failed')
      const [walletChainId, walletAccounts] = await Promise.all([
        walletClient.getChainId(),
        walletClient.request({ method: 'eth_accounts' }),
      ])
      if (walletChainId !== checkedRequest.chainId) throw new Error('Ophis OTC wallet is on the wrong chain')
      const walletAccount = walletAccounts[0]
      if (!walletAccount || !isAddressEqual(walletAccount, checkedRequest.account)) {
        throw new Error('Ophis OTC wallet account changed')
      }
      return walletClient.sendTransaction({
        account: walletClient.account,
        chain: mainnet,
        to: checkedRequest.to,
        data: checkedRequest.data,
        value: checkedRequest.value,
      })
    },
    waitForTransactionReceipt: async (hash) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
      return {
        transactionHash: receipt.transactionHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
      }
    },
  }
}

/** Build both adapters over the wallet's own transport so preflight and send cannot target different RPCs. */
export function toOtcForkClients(walletClient: WagmiWalletClient): {
  writeClient: OtcWriteClient
  wallet: OtcWalletSubmitter
} {
  const connectedPublicClient = walletClient.extend(publicActions)
  // viem's extended Client has the same public action methods as PublicClient;
  // its intersection type is wider because it also retains wallet actions.
  const publicClient = connectedPublicClient as unknown as WagmiPublicClient
  return {
    writeClient: toOtcWriteClient(publicClient),
    wallet: toOtcWalletSubmitter(walletClient, publicClient),
  }
}

/** Legacy web3-react adapter; kept narrow while the host app completes its Wagmi migration. */
export function toOtcLegacyForkClients(
  provider: Web3Provider,
  account: Address,
): { writeClient: OtcWriteClient; wallet: OtcWalletSubmitter } {
  const writeClient: OtcWriteClient = {
    getChainId: async () => (await provider.getNetwork()).chainId,
    getLatestBlock: async () => {
      const block = await provider.getBlock('latest')
      return { number: BigInt(block.number), hash: block.hash as Hex | null }
    },
    getBlockByNumber: async (blockNumber) => {
      const block = await provider.getBlock(safeBlockNumber(blockNumber))
      return { number: BigInt(block.number), hash: block.hash as Hex | null }
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
    sendTransaction: async (request, intent, nowSeconds) => {
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
      const transaction = await signer.sendTransaction({
        to: checkedRequest.to,
        data: checkedRequest.data,
        value: checkedRequest.value,
      })
      return transaction.hash as Hex
    },
    waitForTransactionReceipt: async (hash) => {
      const receipt = await provider.waitForTransaction(hash, 1)
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
