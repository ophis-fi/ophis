import { CHAIN, CHAIN_NAME, NATIVE_SYMBOL, ERC20, NETWORK, TOKENS, ROUTE_INTERMEDIATES, tokenFor, VERSION, type TokenSymbol } from './config'
import { Contract, formatEther, formatUnits, hexlify, randomBytes } from 'ethers'
import { populateShield } from '@railgun-community/wallet'
import type { WalletSession } from './wallet'
import { approveExactShieldToken } from './shield'

export function recoveryIndex(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Enter a nonnegative account index.')
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index > 1_000_000) throw new Error('Recovery index is out of range.')
  return index
}

export async function scanRecovery(session: WalletSession, index: number, additional: readonly TokenSymbol[] = []): Promise<string> {
  if (additional.length > 16) throw new Error('Choose only the tokens relevant to this recovery account.')
  const account = await session.accounts.getAccount(CHAIN, index)
  const native = await session.provider.getBalance(account.address)
  const assets = [...new Set([...ROUTE_INTERMEDIATES, ...additional])]
  const lines = await Promise.all(
    assets.map(async symbol => {
      const token = tokenFor(symbol)
      try {
        const amount = await new Contract(token.address, ERC20, session.provider).getFunction('balanceOf')(account.address, { gasLimit: 100_000n })
        return `${token.symbol}${symbol.startsWith('0x') ? ` (${token.address})` : ''}: ${formatUnits(amount, token.decimals)}`
      } catch {
        return `${token.symbol} (${token.address}): balance unavailable; do not assume zero.`
      }
    }),
  )
  return `Account ${index}: ${account.address}\n${NATIVE_SYMBOL}: ${formatEther(native)}\n${lines.join('\n')}\nChecked ${assets.length} tokens. ${Object.keys(TOKENS).length - assets.length} other listed tokens were not queried. These checks do not discover other contracts; select another token to check it.`
}

export async function recoverToken(session: WalletSession, index: number, symbol: TokenSymbol): Promise<string> {
  const account = await session.accounts.getAccount(CHAIN, index)
  const signer = account.signer.connect(session.provider)
  if ((await session.provider.getNetwork()).chainId !== CHAIN) throw new Error(`${CHAIN_NAME} RPC required.`)
  const asset = tokenFor(symbol)
  const token = new Contract(asset.address, ERC20, signer)
  const amount: bigint = await token.getFunction('balanceOf')(account.address)
  if (amount <= 0n) throw new Error('No token balance to recover.')
  if (amount >= 2n ** 120n) throw new Error('Recovery token amount exceeds the Railgun amount limit. No approval was submitted.')
  if ((await session.provider.getBalance(account.address)) === 0n)
    throw new Error(
      `This temporary account needs ${NATIVE_SYMBOL} for recovery gas. Funding it from your public wallet creates a public link.`,
    )
  await approveExactShieldToken(signer, symbol, amount, async () => {
    if ((await session.provider.getNetwork()).chainId !== CHAIN) throw new Error(`${CHAIN_NAME} RPC required.`)
    if (await token.getFunction('balanceOf')(account.address) < amount) throw new Error('Recovery token balance changed before approval.')
  })
  const { transaction } = await populateShield(
    VERSION,
    NETWORK,
    hexlify(randomBytes(32)),
    [{ tokenAddress: asset.address, amount, recipientAddress: session.info.railgunAddress }],
    [],
  )
  const sent = await signer.sendTransaction(transaction)
  const receipt = await sent.wait()
  if (!receipt || receipt.status !== 1) throw new Error('Recovery shield failed.')
  return sent.hash
}
