import { ARC_CHAIN_ID, ARC_RPC_URL, ARC_FALLBACK_RPC_URL, ARC_USDC_ADDRESS } from '@cowprotocol/common-const'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { cctpNetwork } from 'entities/cctp'
import { createPublicClient, erc20Abi, fallback, http, type Hex, type WalletClient } from 'viem'

import { ARC_SPOKE_POOL, assertAcrossQuote, type AcrossQuote } from './acrossQuote.service'

export const arcClient = createPublicClient({
  chain: cctpNetwork(ARC_CHAIN_ID).chain,
  transport: fallback([ARC_RPC_URL, ARC_FALLBACK_RPC_URL].map((url) => http(url, { retryCount: 0, timeout: 12_000 }))),
})

export async function assertAcrossWallet(wallet: WalletClient, quote: AcrossQuote): Promise<void> {
  const [chainId, addresses, rpcChain, code] = await Promise.all([
    wallet.getChainId(),
    wallet.getAddresses(),
    arcClient.getChainId(),
    arcClient.getCode({ address: quote.owner }),
  ])
  if (chainId !== ARC_CHAIN_ID || rpcChain !== ARC_CHAIN_ID || !areAddressesEqual(addresses[0], quote.owner))
    throw new Error('Wallet or network changed. Connect the sending wallet on Arc and review again.')
  if (code && code !== '0x' && !/^0xef0100[a-fA-F0-9]{40}$/.test(code))
    throw new Error(
      'This Across flow supports personal wallets, including EIP-7702 wallets. Contract wallets need a separate execution flow.',
    )
}

export async function acrossNeedsApproval(quote: AcrossQuote): Promise<boolean> {
  const allowance = await arcClient.readContract({
    address: ARC_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [quote.owner, ARC_SPOKE_POOL],
  })
  return allowance < BigInt(quote.amount)
}

export async function approveAcross(
  wallet: WalletClient,
  quote: AcrossQuote,
  assertCurrent: () => void,
): Promise<void> {
  assertAcrossQuote(quote)
  await assertAcrossWallet(wallet, quote)
  const { request } = await arcClient.simulateContract({
    account: quote.owner,
    address: ARC_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'approve',
    args: [ARC_SPOKE_POOL, BigInt(quote.amount)],
  })
  await assertAcrossWallet(wallet, quote)
  assertCurrent()
  assertAcrossQuote(quote)
  const hash = await wallet.writeContract({ ...request, chain: arcClient.chain })
  const receipt = await arcClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error('USDC approval failed. Please try again.')
}

export async function sendAcross(
  wallet: WalletClient,
  quote: AcrossQuote,
  beforeSignature: (nonce: number) => Promise<void>,
  assertCurrent: () => void,
): Promise<Hex> {
  assertAcrossQuote(quote)
  await assertAcrossWallet(wallet, quote)
  const transaction = { account: quote.owner, to: ARC_SPOKE_POOL, data: quote.data, value: 0n }
  const [estimate, balance, gasPrice, nonce] = await Promise.all([
    arcClient.estimateGas(transaction),
    arcClient.getBalance({ address: quote.owner }),
    arcClient.getGasPrice(),
    arcClient.getTransactionCount({ address: quote.owner, blockTag: 'pending' }),
  ])
  const gas = (estimate * 12n) / 10n
  // Arc's native gas and ERC-20 USDC share a balance, with 18 and 6 decimals respectively.
  if (balance < BigInt(quote.amount) * 10n ** 12n + gas * gasPrice)
    throw new Error('Leave enough USDC on Arc to pay the network fee.')
  await assertAcrossWallet(wallet, quote)
  assertCurrent()
  assertAcrossQuote(quote)
  await beforeSignature(nonce)
  return wallet.sendTransaction({ ...transaction, chain: arcClient.chain, gas, gasPrice, nonce })
}
