import { getWalletTransactionHistory } from '@railgun-community/wallet'
import { Contract, getAddress, type JsonRpcSigner, type TransactionReceipt } from 'ethers'
import { CONFIG, TOKENS, type TokenSymbol } from './config'
import { PRIVACY } from './execution'
import { deletePrivateState, readPrivateState, writePrivateState } from './storage'
import type { WalletSession } from './wallet'
import { assertPublicNetwork } from './shield'

export interface PendingWithdrawal {
  token: TokenSymbol
  recipient: string
  minimum: string
  fromBlock: number
  hash?: string
  nullifiers: string[]
  transaction: { to: string; data: string; value: string }
  minGasPrice: string
}

export async function pendingWithdrawal(session: WalletSession): Promise<PendingWithdrawal | undefined> {
  const stored = await readPrivateState(session, 'pendingWithdrawal')
  if (stored === undefined) return undefined
  if (
    !stored ||
    typeof stored !== 'object' ||
    !('token' in stored) ||
    (stored.token !== 'USDC' && stored.token !== 'WETH') ||
    !('recipient' in stored) ||
    typeof stored.recipient !== 'string' ||
    !('minimum' in stored) ||
    typeof stored.minimum !== 'string' ||
    !/^\d+$/.test(stored.minimum) ||
    !('fromBlock' in stored) ||
    typeof stored.fromBlock !== 'number' ||
    !Number.isSafeInteger(stored.fromBlock) ||
    stored.fromBlock < 0 ||
    !('nullifiers' in stored) ||
    !Array.isArray(stored.nullifiers) ||
    !stored.nullifiers.length ||
    stored.nullifiers.some((n) => typeof n !== 'string' || !/^0x[0-9a-f]{64}$/i.test(n)) ||
    !('transaction' in stored) ||
    !stored.transaction ||
    typeof stored.transaction !== 'object' ||
    !('to' in stored.transaction) ||
    typeof stored.transaction.to !== 'string' ||
    getAddress(stored.transaction.to) !== getAddress(CONFIG.proxyContract) ||
    !('data' in stored.transaction) ||
    typeof stored.transaction.data !== 'string' ||
    !/^0x[0-9a-f]+$/i.test(stored.transaction.data) ||
    !('value' in stored.transaction) ||
    stored.transaction.value !== '0' ||
    !('minGasPrice' in stored) ||
    typeof stored.minGasPrice !== 'string' ||
    !/^\d+$/.test(stored.minGasPrice) ||
    ('hash' in stored &&
      stored.hash !== undefined &&
      (typeof stored.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(stored.hash)))
  )
    throw new Error('Pending withdrawal record is damaged. Restore or repair it before spending again.')
  getAddress(stored.recipient)
  return stored as PendingWithdrawal
}

export async function savePendingWithdrawal(session: WalletSession, pending: PendingWithdrawal): Promise<void> {
  await writePrivateState(session, 'pendingWithdrawal', pending)
}

export function assertWithdrawalReceipt(receipt: TransactionReceipt, pending: PendingWithdrawal): void {
  if (receipt.status !== 1)
    throw new Error('Withdrawal reverted. Resume the saved proof instead of creating another withdrawal.')
  const events = receipt.logs
    .filter((log) => getAddress(log.address) === getAddress(CONFIG.proxyContract))
    .map((log) => PRIVACY.parseLog({ topics: [...log.topics], data: log.data }))
  const nullifiers = events.flatMap((event) =>
    event?.name === 'Nullified' ? [...event.args.nullifier].map((n: string) => n.toLowerCase()) : [],
  )
  const output = events.reduce(
    (sum, event) =>
      event?.name === 'Unshield' &&
      getAddress(event.args.to) === getAddress(pending.recipient) &&
      getAddress(event.args.token.tokenAddress) === getAddress(TOKENS[pending.token].address)
        ? sum + BigInt(event.args.amount)
        : sum,
    0n,
  )
  if (
    BigInt(pending.minimum) <= 0n ||
    output < BigInt(pending.minimum) ||
    !pending.nullifiers.every((n) => nullifiers.includes(n.toLowerCase()))
  )
    throw new Error('The saved withdrawal output and nullifiers are not confirmed.')
}

export async function reconcilePendingWithdrawal(session: WalletSession): Promise<string> {
  const pending = await pendingWithdrawal(session)
  if (!pending) return 'No pending withdrawal.'
  // Starting at submission would hide spends of notes created before that block.
  const history = (await getWalletTransactionHistory(CONFIG.chain, session.info.id, undefined))
    .filter(
      (item) =>
        (item.blockNumber == null || item.blockNumber >= pending.fromBlock) &&
        item.unshieldERC20Amounts.some(
          (amount) => amount.recipientAddress && getAddress(amount.recipientAddress) === getAddress(pending.recipient),
        ),
    )
    .map((item) => (item.txid.startsWith('0x') ? item.txid : `0x${item.txid}`))
  const candidates = [...new Set([...(pending.hash ? [pending.hash] : []), ...history])]
  for (const hash of candidates) {
    const receipt = await session.provider.getTransactionReceipt(hash)
    if (!receipt || (await receipt.confirmations()) < 2) continue
    try {
      assertWithdrawalReceipt(receipt, pending)
    } catch {
      continue
    }
    await deletePrivateState(session, 'pendingWithdrawal')
    return `Withdrawal confirmed: ${hash}`
  }
  const [transactions] = PRIVACY.decodeFunctionData('transact', pending.transaction.data)
  const inputs = [...transactions].flatMap((transaction) =>
    [...transaction.nullifiers].map((nullifier) => ({
      tree: transaction.boundParams.treeNumber,
      nullifier: String(nullifier).toLowerCase(),
    })),
  )
  if (!pending.nullifiers.every((nullifier) => inputs.some((input) => input.nullifier === nullifier.toLowerCase())))
    throw new Error('Saved withdrawal proof does not match its nullifiers.')
  const confirmedBlock = Math.max(0, (await session.provider.getBlockNumber()) - 1)
  const proxy = new Contract(CONFIG.proxyContract, PRIVACY, session.provider)
  const spent: boolean[] = await Promise.all(
    inputs.map((input) => proxy.getFunction('nullifiers')(input.tree, input.nullifier, { blockTag: confirmedBlock })),
  )
  if (spent.some(Boolean)) {
    await deletePrivateState(session, 'pendingWithdrawal')
    return 'Saved withdrawal proof is no longer executable: an input was spent. Check wallet history for the actual outcome; this does not confirm the requested output.'
  }
  throw new Error(
    'Withdrawal is not confirmed. Check again or resume its saved proof with public gas; do not create another withdrawal.',
  )
}

export async function resumePendingWithdrawal(session: WalletSession, sponsor: JsonRpcSigner): Promise<string> {
  const pending = await pendingWithdrawal(session)
  if (!pending) throw new Error('No saved withdrawal to resume.')
  // Reusing the exact proof cannot withdraw twice: its nullifiers can only be spent once.
  await assertPublicNetwork(session, sponsor)
  const fees = await session.provider.getFeeData()
  const maxPriorityFeePerGas =
    BigInt(pending.minGasPrice) > (fees.maxPriorityFeePerGas || 0n)
      ? BigInt(pending.minGasPrice)
      : fees.maxPriorityFeePerGas || 0n
  const maxFeePerGas =
    maxPriorityFeePerGas * 2n > (fees.maxFeePerGas || 0n) ? maxPriorityFeePerGas * 2n : fees.maxFeePerGas || 0n
  const sent = await sponsor.sendTransaction({
    ...pending.transaction,
    value: BigInt(pending.transaction.value),
    type: 2,
    maxPriorityFeePerGas,
    maxFeePerGas,
  })
  await savePendingWithdrawal(session, { ...pending, hash: sent.hash })
  const receipt = await sent.wait(2)
  if (!receipt) throw new Error('Withdrawal confirmation is pending. Keep the saved record.')
  return reconcilePendingWithdrawal(session)
}
