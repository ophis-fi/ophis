import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { BaseError, encodeFunctionData, erc20Abi, type Address, type Hex, type WalletClient } from 'viem'

import { CCTP_ABI, MESSAGE_TRANSMITTER, TOKEN_MESSENGER, cctpNetwork } from './cctp.const'
import {
  assertCctpQuote,
  cctpBurnData,
  cctpClient,
  readCctpFunds,
  verifyCctpNetwork,
  type CctpQuote,
} from './cctp.service'
import { validateCctpMessage } from './cctpStatus.service'

function isUnknownChain(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 4902
}

export async function switchCctpChain(wallet: WalletClient, chainId: number): Promise<void> {
  const { chain } = cctpNetwork(chainId)
  try {
    await wallet.switchChain({ id: chain.id })
  } catch (error) {
    if (!isUnknownChain(error instanceof BaseError ? error.walk(isUnknownChain) : error)) throw error
    await wallet.addChain({ chain })
    await wallet.switchChain({ id: chain.id })
  }
}

export async function assertCctpWallet(wallet: WalletClient, owner: Address, chainId: number): Promise<void> {
  const [id, accounts] = await Promise.all([wallet.getChainId(), wallet.getAddresses()])
  if (id !== chainId || !accounts[0] || !areAddressesEqual(accounts[0], owner))
    throw new Error('Wallet account or network changed. Review the bridge again.')
}

async function prepareCctpCall(
  quote: CctpQuote,
  chainId: number,
  to: Address,
  data: Hex,
  burn: boolean,
): Promise<void> {
  const client = cctpClient(chainId)
  await verifyCctpNetwork(chainId)
  const [gas, gasPrice, balance] = await Promise.all([
    client.estimateGas({ account: quote.owner, to, data, value: 0n }),
    client.getGasPrice(),
    client.getBalance({ address: quote.owner }),
  ])
  const principal = burn && chainId === 5042 ? BigInt(quote.amount) * 1_000_000_000_000n : 0n
  if (balance < principal + gas * gasPrice * 2n) throw new Error('Leave enough native currency to pay transaction gas')
}

export async function approveCctp(wallet: WalletClient, quote: CctpQuote): Promise<Hex | undefined> {
  assertCctpQuote(quote)
  await assertCctpWallet(wallet, quote.owner, quote.source)
  const { allowance, balance } = await readCctpFunds(quote)
  if (balance < BigInt(quote.amount)) throw new Error('Insufficient USDC balance')
  if (allowance >= BigInt(quote.amount)) return undefined
  const to = cctpNetwork(quote.source).usdc
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [TOKEN_MESSENGER, BigInt(quote.amount)],
  })
  await prepareCctpCall(quote, quote.source, to, data, false)
  await assertCctpWallet(wallet, quote.owner, quote.source)
  return wallet.sendTransaction({ account: quote.owner, chain: cctpNetwork(quote.source).chain, to, data, value: 0n })
}

export async function burnCctp(
  wallet: WalletClient,
  quote: CctpQuote,
  beforeSignature: (nonce: number) => Promise<void>,
): Promise<Hex> {
  assertCctpQuote(quote)
  await assertCctpWallet(wallet, quote.owner, quote.source)
  const { allowance, balance } = await readCctpFunds(quote)
  if (allowance < BigInt(quote.amount) || balance < BigInt(quote.amount))
    throw new Error('USDC approval or balance is insufficient')
  const data = cctpBurnData(quote)
  await verifyCctpNetwork(quote.destination)
  const codes = await Promise.all(
    [quote.source, quote.destination].map((id) => cctpClient(id).getCode({ address: quote.owner })),
  )
  // A Safe at the source address need not exist or have the same owners elsewhere.
  if (codes.some((code) => code && code !== '0x'))
    throw new Error('CCTP currently supports personal wallets without smart-account code only')
  await prepareCctpCall(quote, quote.source, TOKEN_MESSENGER, data, true)
  const nonce = await cctpClient(quote.source).getTransactionCount({ address: quote.owner, blockTag: 'pending' })
  // Fee and account must still match after the asynchronous reads/simulation.
  assertCctpQuote(quote)
  await assertCctpWallet(wallet, quote.owner, quote.source)
  await beforeSignature(nonce)
  return wallet.sendTransaction({
    account: quote.owner,
    chain: cctpNetwork(quote.source).chain,
    to: TOKEN_MESSENGER,
    nonce,
    data,
    value: 0n,
  })
}

export async function claimCctp(
  wallet: WalletClient,
  quote: CctpQuote,
  message: Hex,
  attestation: Hex,
  beforeSignature: (nonce: number) => Promise<void>,
): Promise<Hex> {
  validateCctpMessage(message, quote)
  await assertCctpWallet(wallet, quote.owner, quote.destination)
  const data = encodeFunctionData({ abi: CCTP_ABI, functionName: 'receiveMessage', args: [message, attestation] })
  await prepareCctpCall(quote, quote.destination, MESSAGE_TRANSMITTER, data, false)
  const nonce = await cctpClient(quote.destination).getTransactionCount({ address: quote.owner, blockTag: 'pending' })
  await assertCctpWallet(wallet, quote.owner, quote.destination)
  await beforeSignature(nonce)
  return wallet.sendTransaction({
    account: quote.owner,
    nonce,
    chain: cctpNetwork(quote.destination).chain,
    to: MESSAGE_TRANSMITTER,
    data,
    value: 0n,
  })
}
