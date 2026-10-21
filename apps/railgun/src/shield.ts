import {
  BrowserProvider,
  Contract,
  hexlify,
  randomBytes,
  isError,
  type Eip1193Provider,
  type JsonRpcSigner,
  type TransactionReceipt,
} from 'ethers'
import { populateShield } from '@railgun-community/wallet'
import { CONFIG, ENVIRONMENT, ERC20, NETWORK, TOKENS, VERSION, type TokenSymbol } from './config'
import type { WalletSession } from './wallet'
import { forkMarker } from './fork-marker'

export class PublicNetworkError extends Error {
  constructor() { super('Switch your public wallet to Ethereum, then reconnect.') }
}

export async function publicSigner(
  ethereum: Eip1193Provider,
  session: WalletSession,
): Promise<JsonRpcSigner> {
  const provider = new BrowserProvider(ethereum)
  await provider.send('eth_requestAccounts', [])
  const signer = await provider.getSigner()
  await assertPublicNetwork(session, signer)
  return signer
}

export async function assertPublicNetwork(
  session: WalletSession,
  signer: JsonRpcSigner,
): Promise<void> {
  const network = await signer.provider.getNetwork().catch((error: unknown) => {
    if (isError(error, 'NETWORK_ERROR')) throw new PublicNetworkError()
    throw error
  })
  if (network.chainId !== 1n) throw new PublicNetworkError()
  if (ENVIRONMENT !== 'fork') return
  const marker = forkMarker(await session.provider.send('anvil_metadata', []))
  // MetaMask filters anvil_metadata; a per-instance marker uses standard wallet RPC instead.
  const codes: unknown[] = await Promise.all(
    [session.provider, signer.provider].map((provider) =>
      provider.send('eth_getCode', [marker.address, 'latest']),
    ),
  )
  if (!codes.every((code) => code === marker.code))
    throw new Error(
      'Prepare the local fork marker, then connect your test wallet to that fork. Other forks and mainnet wallets cannot fund this test build.',
    )
}

export async function shieldAllowance(signer: JsonRpcSigner, token: TokenSymbol): Promise<bigint> {
  return new Contract(TOKENS[token].address, ERC20, signer).getFunction('allowance')(
    await signer.getAddress(),
    CONFIG.proxyContract,
  )
}

export async function approveShield(
  session: WalletSession,
  signer: JsonRpcSigner,
  token: TokenSymbol,
  amount: bigint,
): Promise<TransactionReceipt> {
  await assertPublicNetwork(session, signer)
  const response = await new Contract(TOKENS[token].address, ERC20, signer).getFunction('approve')(
    CONFIG.proxyContract,
    amount,
  )
  const receipt = await response.wait()
  if (!receipt || receipt.status !== 1) throw new Error('Approval was not confirmed.')
  return receipt
}

export async function shield(
  session: WalletSession,
  signer: JsonRpcSigner,
  token: TokenSymbol,
  amount: bigint,
): Promise<TransactionReceipt> {
  await assertPublicNetwork(session, signer)
  if (amount <= 0n || (await shieldAllowance(signer, token)) < amount)
    throw new Error('Approve this token amount first.')
  const recipient = {
    tokenAddress: TOKENS[token].address,
    amount,
    recipientAddress: session.info.railgunAddress,
  }
  const { transaction } = await populateShield(
    VERSION,
    NETWORK,
    hexlify(randomBytes(32)),
    [recipient],
    [],
  )
  const response = await signer.sendTransaction(transaction)
  const receipt = await response.wait()
  if (!receipt || receipt.status !== 1) throw new Error('Shield was not confirmed.')
  return receipt
}
