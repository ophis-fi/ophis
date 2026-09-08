import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import type { Web3Provider } from '@ethersproject/providers'

import { toOtcReaderClient } from 'ophis/otc'
import {
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
import { assertOtcCanaryIntent } from './otcCanaryPolicy'
import {
  assertForkIdentity,
  getOtcProviderForkId,
  getOtcWalletForkId,
  verifyOtcLocalForkProvider,
  verifyOtcLocalForkWallet,
} from './otcForkIdentity'
import { OTC_RECEIPT_TIMEOUT_MS, waitForOtcReceipt } from './otcReceiptTracking.utils'
import { assertOtcRuntimeControl } from './otcRuntimeControl'
import { readOtcSubmissionProof } from './otcTransactionProof'
import { verifyOtcCanaryNetwork } from './verifyOtcCanaryNetwork'

import type { OtcWalletSubmitter, OtcWriteClient, OtcWriteIntent } from './otcWrite.types'

type WagmiPublicClient = NonNullable<ReturnType<typeof usePublicClient>>
type WagmiWalletClient = WalletClient<Transport, Chain, Account>

function safeBlockNumber(blockNumber: bigint): number {
  const value = Number(blockNumber)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Ophis OTC block number is unsafe')
  return value
}

function assertOtcSigningContext(intent: OtcWriteIntent, canary: boolean, isCurrentContext: () => boolean): void {
  if (!isCurrentContext()) throw new Error('Ophis OTC action context changed')
  if (canary) assertOtcCanaryIntent(intent, BigInt(Math.floor(Date.now() / 1_000)))
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
  canaryClient?: WagmiPublicClient,
): OtcWalletSubmitter {
  return {
    sendTransaction: async (
      request,
      intent,
      nowSeconds,
      isCurrentContext = () => true,
      onSignatureRequested = () => undefined,
    ) => {
      const checkedRequest = Object.freeze({ ...request })
      assertOtcTransactionRequest(checkedRequest, intent, nowSeconds)
      if (canaryClient) {
        await verifyOtcCanaryNetwork(toOtcReaderClient(publicClient), toOtcReaderClient(canaryClient))
        assertOtcCanaryIntent(intent, nowSeconds)
      } else if (!(await verifyOtcLocalForkWallet(walletClient))) {
        throw new Error('Ophis OTC local fork verification failed')
      }
      const [walletChainId, walletAccounts] = await Promise.all([
        walletClient.getChainId(),
        walletClient.request({ method: 'eth_accounts' }),
      ])
      if (walletChainId !== checkedRequest.chainId) throw new Error('Ophis OTC wallet is on the wrong chain')
      if (
        ![walletAccounts[0], walletClient.account?.address].every(
          (candidate) => !!candidate && areAddressesEqual(candidate, checkedRequest.account),
        )
      )
        throw new Error('Ophis OTC wallet account changed')
      await assertForkIdentity(() => getOtcWalletForkId(walletClient), expectedForkId)
      const proof = await readOtcSubmissionProof(canaryClient, checkedRequest, () =>
        publicClient.getTransactionCount({ address: checkedRequest.account, blockTag: 'pending' }),
      )
      if (canaryClient) await assertOtcRuntimeControl()
      assertOtcSigningContext(intent, !!canaryClient, isCurrentContext)
      onSignatureRequested(proof)
      return walletClient.sendTransaction({
        account: walletClient.account,
        chain: mainnet,
        to: checkedRequest.to,
        data: checkedRequest.data,
        value: checkedRequest.value,
        nonce: proof?.nonce,
      })
    },
    waitForTransactionReceipt: async (hash, proof) => {
      if (canaryClient && !proof) throw new Error('Ophis OTC transaction proof unavailable')
      await assertForkIdentity(() => getOtcWalletForkId(walletClient), expectedForkId)
      const receipt = await waitForOtcReceipt(canaryClient ?? publicClient, hash, proof)
      await assertForkIdentity(() => getOtcWalletForkId(walletClient), expectedForkId)
      return receipt
    },
  }
}

/** Fork state stays on its wallet transport; canary state and simulation come from independent Ethereum reads. */
export function toOtcForkClients(
  walletClient: WagmiWalletClient,
  expectedForkId?: Hex,
  canaryClient?: WagmiPublicClient,
): {
  writeClient: OtcWriteClient
  connectedReader: OtcWriteClient
  wallet: OtcWalletSubmitter
} {
  const connectedPublicClient = walletClient.extend(publicActions)
  // viem's extended Client has the same public action methods as PublicClient;
  // its intersection type is wider because it also retains wallet actions.
  const publicClient = connectedPublicClient as unknown as WagmiPublicClient
  return {
    writeClient: toOtcWriteClient(canaryClient ?? publicClient),
    connectedReader: toOtcWriteClient(publicClient),
    wallet: toOtcWalletSubmitter(walletClient, publicClient, expectedForkId, canaryClient),
  }
}

function toOtcLegacyWriteClient(provider: Web3Provider): OtcWriteClient {
  return {
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
}

/** Legacy web3-react adapter; kept narrow while the host app completes its Wagmi migration. */
export function toOtcLegacyForkClients(
  provider: Web3Provider,
  account: Address,
  expectedForkId?: Hex,
  canaryClient?: WagmiPublicClient,
): { writeClient: OtcWriteClient; connectedReader: OtcWriteClient; wallet: OtcWalletSubmitter } {
  const connectedReader = toOtcLegacyWriteClient(provider)
  const wallet: OtcWalletSubmitter = {
    sendTransaction: async (
      request,
      intent,
      nowSeconds,
      isCurrentContext = () => true,
      onSignatureRequested = () => undefined,
    ) => {
      const checkedRequest = Object.freeze({ ...request })
      assertOtcTransactionRequest(checkedRequest, intent, nowSeconds)
      if (canaryClient) {
        await verifyOtcCanaryNetwork(connectedReader, toOtcReaderClient(canaryClient))
        assertOtcCanaryIntent(intent, nowSeconds)
      } else if (!(await verifyOtcLocalForkProvider(provider))) {
        throw new Error('Ophis OTC local fork verification failed')
      }
      const [network, providerAccounts] = await Promise.all([provider.getNetwork(), provider.listAccounts()])
      if (network.chainId !== checkedRequest.chainId) throw new Error('Ophis OTC wallet is on the wrong chain')
      if (
        ![account, providerAccounts[0]].every(
          (candidate) => !!candidate && areAddressesEqual(candidate, checkedRequest.account),
        )
      )
        throw new Error('Ophis OTC wallet account changed')
      const signer = provider.getSigner(checkedRequest.account)
      await assertForkIdentity(() => getOtcProviderForkId(provider), expectedForkId)
      const proof = await readOtcSubmissionProof(canaryClient, checkedRequest, () =>
        provider.getTransactionCount(checkedRequest.account, 'pending'),
      )
      if (canaryClient) await assertOtcRuntimeControl()
      assertOtcSigningContext(intent, !!canaryClient, isCurrentContext)
      onSignatureRequested(proof)
      const transaction = await signer.sendTransaction({
        to: checkedRequest.to,
        data: checkedRequest.data,
        value: checkedRequest.value,
        nonce: proof?.nonce,
      })
      return transaction.hash as Hex
    },
    waitForTransactionReceipt: async (hash, proof) => {
      if (canaryClient && !proof) throw new Error('Ophis OTC transaction proof unavailable')
      if (canaryClient) return waitForOtcReceipt(canaryClient, hash, proof)
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
  return { writeClient: canaryClient ? toOtcWriteClient(canaryClient) : connectedReader, connectedReader, wallet }
}
