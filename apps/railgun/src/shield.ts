import { NATIVE_SYMBOL, WRAPPED_SYMBOL, isTokenSymbol, tokenFor, CHAIN, CHAIN_NAME, CONFIG, ENVIRONMENT, ERC20, NETWORK, TOKENS, VERSION, type TokenSymbol } from './config'
import {
  BrowserProvider,
  Contract,
  formatUnits,
  hexlify,
  randomBytes,
  isError,
  type Eip1193Provider,
  type JsonRpcSigner,
  type TransactionReceipt,
} from 'ethers'
import { populateShield, populateShieldBaseToken } from '@railgun-community/wallet'
import type { WalletSession } from './wallet'
import { forkMarker } from './fork-marker'

export type ShieldToken = TokenSymbol | 'ETH' | 'POL' | 'BNB'

export class PublicNetworkError extends Error {
  constructor() { super(`Switch your public wallet to ${CHAIN_NAME}, then reconnect.`) }
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
  if (network.chainId !== CHAIN) throw new PublicNetworkError()
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
  return new Contract(tokenFor(token).address, ERC20, signer).getFunction('allowance')(
    await signer.getAddress(),
    CONFIG.proxyContract,
  )
}

export async function requireShieldBalance(signer: JsonRpcSigner, token: ShieldToken, amount: bigint): Promise<void> {
  if (amount <= 0n) throw new Error('Enter a positive token amount.')
  const owner = await signer.getAddress()
  const decimals = token === NATIVE_SYMBOL ? 18 : tokenFor(token).decimals
  const balance: bigint = token === NATIVE_SYMBOL
    ? await signer.provider.getBalance(owner)
    : await new Contract(tokenFor(token).address, ERC20, signer).getFunction('balanceOf')(owner)
  if (balance < amount)
    throw new Error(
      `Public wallet balance: ${formatUnits(balance, decimals)} ${token}.\n` +
      `Required to shield: ${formatUnits(amount, decimals)} ${token}.\n` +
      (token === WRAPPED_SYMBOL
        ? `Choose ${NATIVE_SYMBOL} as the deposit asset to use it directly. Token approval does not wrap native funds.`
        : token === NATIVE_SYMBOL
          ? `Your connected public wallet needs this ${NATIVE_SYMBOL} amount plus ${NATIVE_SYMBOL} for gas.`
          : 'Your connected public wallet needs this token amount before shielding.'),
    )
}

export async function approveShield(
  session: WalletSession,
  signer: JsonRpcSigner,
  token: TokenSymbol,
  amount: bigint,
  onStatus: (message: string) => void = () => {},
): Promise<TransactionReceipt> {
  await assertPublicNetwork(session, signer)
  await requireShieldBalance(signer, token, amount)
  if (token === 'USDT' && await shieldAllowance(signer, token) > 0n) {
    onStatus('USDT requires clearing its existing allowance first. Confirm the reset in your wallet.')
    const reset = await new Contract(tokenFor(token).address, ERC20, signer).getFunction('approve')(CONFIG.proxyContract, 0n)
    const cleared = await reset.wait()
    if (!cleared || cleared.status !== 1) throw new Error('USDT allowance reset was not confirmed.')
    await assertPublicNetwork(session, signer)
    await requireShieldBalance(signer, token, amount)
  }
  onStatus(`Confirm the ${token} approval in your connected wallet. Open your wallet app and check its requests. A request can remain pending; do not submit it again.`)
  const response = await new Contract(tokenFor(token).address, ERC20, signer).getFunction('approve')(
    CONFIG.proxyContract,
    amount,
  )
  onStatus(`Approval submitted: ${response.hash}. Waiting for ${CHAIN_NAME} confirmation.`)
  const receipt = await response.wait()
  if (!receipt || receipt.status !== 1) throw new Error('Approval was not confirmed.')
  onStatus(`Approval confirmed: ${receipt.hash}. Next: click Shield amount and confirm the separate deposit in your wallet.`)
  return receipt
}

export async function shield(
  session: WalletSession,
  signer: JsonRpcSigner,
  token: ShieldToken,
  amount: bigint,
  onStatus: (message: string) => void = () => {},
): Promise<TransactionReceipt> {
  onStatus('Checking your public wallet network and balance…')
  await assertPublicNetwork(session, signer)
  await requireShieldBalance(signer, token, amount)
  if (isTokenSymbol(token) && (await shieldAllowance(signer, token)) < amount)
    throw new Error('Approve this token amount first.')
  const recipient = {
    tokenAddress: tokenFor(token === NATIVE_SYMBOL ? WRAPPED_SYMBOL : token).address,
    amount,
    recipientAddress: session.info.railgunAddress,
  }
  const shieldKey = hexlify(randomBytes(32))
  onStatus(`Preparing your ${token} deposit…`)
  const { transaction } = token === NATIVE_SYMBOL
    ? await populateShieldBaseToken(VERSION, NETWORK, session.info.railgunAddress, shieldKey, recipient)
    : await populateShield(VERSION, NETWORK, shieldKey, [recipient], [])
  if (token === NATIVE_SYMBOL && (transaction.to?.toLowerCase() !== CONFIG.relayAdaptContract.toLowerCase() || transaction.value !== amount))
    throw new Error(`${NATIVE_SYMBOL} deposit transaction does not match the expected Railgun contract and amount.`)
  await assertPublicNetwork(session, signer)
  onStatus(`Confirm the ${formatUnits(amount, token === NATIVE_SYMBOL ? 18 : tokenFor(token).decimals)} ${token} deposit in your connected wallet. Open your wallet app and check its requests. A request can remain pending; do not submit it again.`)
  const response = await signer.sendTransaction(transaction)
  onStatus(`Deposit submitted: ${response.hash}. Waiting for ${CHAIN_NAME} confirmation. Do not submit it again.`)
  const receipt = await response.wait()
  if (!receipt || receipt.status !== 1) throw new Error('Shield was not confirmed.')
  onStatus(`Deposit confirmed: ${receipt.hash}. Railgun validation usually takes about one hour. Use Refresh balances afterward and wait for Spendable before a private swap.`)
  return receipt
}
