import { Contract, formatEther, formatUnits, hexlify, randomBytes } from 'ethers'
import { populateShield } from '@railgun-community/wallet'
import { CONFIG, ERC20, NETWORK, TOKENS, VERSION, type TokenSymbol } from './config'
import type { WalletSession } from './wallet'

export function recoveryIndex(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Enter a nonnegative account index.')
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index > 1_000_000) throw new Error('Recovery index is out of range.')
  return index
}

export async function scanRecovery(session: WalletSession, index: number): Promise<string> {
  const account = await session.accounts.getAccount(1n, index)
  const native = await session.provider.getBalance(account.address)
  const lines = await Promise.all(
    Object.entries(TOKENS).map(async ([symbol, token]) => {
      const amount = await new Contract(token.address, ERC20, session.provider).getFunction('balanceOf')(
        account.address,
      )
      return `${symbol}: ${formatUnits(amount, token.decimals)}`
    }),
  )
  return `Account ${index}: ${account.address}\nETH: ${formatEther(native)}\n${lines.join('\n')}`
}

export async function recoverToken(session: WalletSession, index: number, symbol: TokenSymbol): Promise<string> {
  const account = await session.accounts.getAccount(1n, index)
  const signer = account.signer.connect(session.provider)
  if ((await session.provider.getNetwork()).chainId !== 1n) throw new Error('Ethereum RPC required.')
  const token = new Contract(TOKENS[symbol].address, ERC20, signer)
  const amount: bigint = await token.getFunction('balanceOf')(account.address)
  if (amount <= 0n) throw new Error('No token balance to recover.')
  if ((await session.provider.getBalance(account.address)) === 0n)
    throw new Error(
      'This temporary account needs ETH for recovery gas. Funding it from your public wallet creates a public link.',
    )
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
