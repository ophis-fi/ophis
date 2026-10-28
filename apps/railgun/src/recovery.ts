import { CHAIN, CHAIN_NAME, NATIVE_SYMBOL, CONFIG, ERC20, NETWORK, TOKENS, VERSION, type TokenSymbol } from './config'
import { Contract, formatEther, formatUnits, hexlify, randomBytes } from 'ethers'
import { populateShield } from '@railgun-community/wallet'
import type { WalletSession } from './wallet'

export function recoveryIndex(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Enter a nonnegative account index.')
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index > 1_000_000) throw new Error('Recovery index is out of range.')
  return index
}

export async function scanRecovery(session: WalletSession, index: number): Promise<string> {
  const account = await session.accounts.getAccount(CHAIN, index)
  const native = await session.provider.getBalance(account.address)
  const lines = await Promise.all(
    Object.entries(TOKENS).map(async ([symbol, token]) => {
      const amount = await new Contract(token.address, ERC20, session.provider).getFunction('balanceOf')(
        account.address,
      )
      return `${symbol}: ${formatUnits(amount, token.decimals)}`
    }),
  )
  return `Account ${index}: ${account.address}\n${NATIVE_SYMBOL}: ${formatEther(native)}\n${lines.join('\n')}`
}

export async function recoverToken(session: WalletSession, index: number, symbol: TokenSymbol): Promise<string> {
  const account = await session.accounts.getAccount(CHAIN, index)
  const signer = account.signer.connect(session.provider)
  if ((await session.provider.getNetwork()).chainId !== CHAIN) throw new Error(`${CHAIN_NAME} RPC required.`)
  const token = new Contract(TOKENS[symbol].address, ERC20, signer)
  const amount: bigint = await token.getFunction('balanceOf')(account.address)
  if (amount <= 0n) throw new Error('No token balance to recover.')
  if ((await session.provider.getBalance(account.address)) === 0n)
    throw new Error(
      `This temporary account needs ${NATIVE_SYMBOL} for recovery gas. Funding it from your public wallet creates a public link.`,
    )
  if (symbol === 'USDT' && await token.getFunction('allowance')(account.address, CONFIG.proxyContract) > 0n) {
    const reset = await token.getFunction('approve')(CONFIG.proxyContract, 0n)
    const cleared = await reset.wait()
    if (!cleared || cleared.status !== 1) throw new Error('USDT recovery allowance reset was not confirmed.')
  }
  const approval = await token.getFunction('approve')(CONFIG.proxyContract, amount)
  const approved = await approval.wait()
  if (!approved || approved.status !== 1) throw new Error('Recovery approval failed.')
  const { transaction } = await populateShield(
    VERSION,
    NETWORK,
    hexlify(randomBytes(32)),
    [{ tokenAddress: TOKENS[symbol].address, amount, recipientAddress: session.info.railgunAddress }],
    [],
  )
  const sent = await signer.sendTransaction(transaction)
  const receipt = await sent.wait()
  if (!receipt || receipt.status !== 1) throw new Error('Recovery shield failed.')
  return sent.hash
}
