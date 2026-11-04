import { CHAIN_ID, isTokenSymbol, CONFIG, TOKENS, PILOT_WITHDRAWAL_RECIPIENT, type TokenSymbol } from './config'
import { getWalletTransactionHistory } from '@railgun-community/wallet'
import { Contract, formatUnits, getAddress, type JsonRpcSigner, type TransactionReceipt } from 'ethers'
import { assertAtomicWithdrawal, PRIVACY } from './execution'
import { deletePrivateState, readPrivateState, writePrivateState } from './storage'
import type { WalletSession } from './wallet'
import { assertPublicNetwork } from './shield'

export interface PendingWithdrawal {
  chainId?: number
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
  return readWithdrawal(session, 'pendingWithdrawal')
}

export async function preservedWithdrawal(session: WalletSession): Promise<PendingWithdrawal | undefined> {
  return readWithdrawal(session, 'preservedWithdrawal')
}

async function readWithdrawal(session: WalletSession, key: 'pendingWithdrawal' | 'preservedWithdrawal'): Promise<PendingWithdrawal | undefined> {
  const stored = await readPrivateState(session, key)
  if (stored === undefined) return undefined
  if (
    !stored ||
    typeof stored !== 'object' ||
    ('chainId' in stored ? stored.chainId !== CHAIN_ID : CHAIN_ID !== 1) ||
    !('token' in stored) ||
    !isTokenSymbol(stored.token) ||
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
  if (pending.chainId !== undefined && pending.chainId !== CHAIN_ID) throw new Error('Pending withdrawal network changed.')
  await writePrivateState(session, 'pendingWithdrawal', { ...pending, chainId: CHAIN_ID })
}

export function savedWithdrawalSummary(pending: PendingWithdrawal): string {
  const note = PRIVACY.decodeFunctionData('transact', pending.transaction.data)[0][0].unshieldPreimage
  const asset = Object.values(TOKENS).find((item) => getAddress(item.address) === getAddress(note.token.tokenAddress))
  const amount = asset ? `${formatUnits(note.value, asset.decimals)} ${asset.symbol}` : `unknown token ${note.token.tokenAddress}`
  const format = BigInt(note.token.tokenType) === 0n && BigInt(note.token.tokenSubID) === 0n ? '' : ' (unsupported token format)'
  return `Saved withdrawal: ${amount}${format} to ${pending.recipient}`
}

export function canPreserveWethWithdrawal(pending: PendingWithdrawal): boolean {
  if (CHAIN_ID !== 1 || !PILOT_WITHDRAWAL_RECIPIENT || pending.hash) return false
  const [transactions] = PRIVACY.decodeFunctionData('transact', pending.transaction.data)
  if (transactions.length !== 1 || transactions[0].boundParams.unshield !== 1n) return false
  const note = transactions[0].unshieldPreimage
  return getAddress(note.token.tokenAddress) === getAddress(TOKENS.WETH.address) &&
    note.token.tokenType === 0n && note.token.tokenSubID === 0n && note.value > 0n &&
    BigInt(note.npk) === BigInt(PILOT_WITHDRAWAL_RECIPIENT) &&
    getAddress(pending.recipient) === getAddress(PILOT_WITHDRAWAL_RECIPIENT)
}

export async function preserveWethWithdrawal(session: WalletSession): Promise<void> {
  const pending = await pendingWithdrawal(session)
  if (!pending || !canPreserveWethWithdrawal(pending)) throw new Error('Only the unsupported WETH pilot proof without a transaction hash can be set aside.')
  if (await withdrawalInputsSpent(session, pending)) throw new Error('A saved input is spent. Check the withdrawal outcome first.')
  const preserved = await preservedWithdrawal(session)
  if (preserved && preserved.transaction.data !== pending.transaction.data)
    throw new Error('Another preserved withdrawal exists. Keep both records and resolve it first.')
  // Persist the complete encrypted proof before releasing its active slot; this does not revoke it.
  await writePrivateState(session, 'preservedWithdrawal', pending)
  await deletePrivateState(session, 'pendingWithdrawal')
}

export async function restorePreservedWithdrawal(session: WalletSession): Promise<void> {
  if (await pendingWithdrawal(session)) throw new Error('Resolve the active withdrawal before restoring another proof.')
  const preserved = await preservedWithdrawal(session)
  if (!preserved) throw new Error('No preserved withdrawal exists.')
  if (await withdrawalInputsSpent(session, preserved)) throw new Error('A preserved input is spent. Check wallet history first.')
  await savePendingWithdrawal(session, preserved)
  await deletePrivateState(session, 'preservedWithdrawal')
}

function withdrawalInputs(pending: PendingWithdrawal) {
  const [transactions] = PRIVACY.decodeFunctionData('transact', pending.transaction.data)
  const inputs = [...transactions].flatMap((transaction) => [...transaction.nullifiers].map((nullifier) => ({
    tree: transaction.boundParams.treeNumber,
    nullifier: String(nullifier).toLowerCase(),
  })))
  if (inputs.length !== pending.nullifiers.length ||
    !pending.nullifiers.every((nullifier) => inputs.some((input) => input.nullifier === nullifier.toLowerCase())))
    throw new Error('Saved withdrawal proof does not match its nullifiers.')
  return inputs
}

export function assertWithdrawalReceipt(receipt: TransactionReceipt, pending: PendingWithdrawal): void {
  if (receipt.status !== 1)
    throw new Error('Withdrawal reverted. Resume the saved proof instead of creating another withdrawal.')
  const events = receipt.logs
    .filter((log) => getAddress(log.address) === getAddress(CONFIG.proxyContract))
    .map((log) => PRIVACY.parseLog({ topics: [...log.topics], data: log.data }))
  const nullifiers = events.flatMap((event) =>
    event?.name === 'Nullified' ? [...event.args.nullifier].map((n: string) => `${event.args[0]}:${n.toLowerCase()}`) : [],
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
    !(receipt.blockNumber >= pending.fromBlock) ||
    !withdrawalInputs(pending).every((input) => nullifiers.includes(`${input.tree}:${input.nullifier}`))
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
  if (await withdrawalInputsSpent(session, pending)) {
    await deletePrivateState(session, 'pendingWithdrawal')
    return 'Saved withdrawal proof is no longer executable: an input was spent. Check wallet history for the actual outcome; this does not confirm the requested output.'
  }
  throw new Error(
    `${savedWithdrawalSummary(pending)}\nWithdrawal is not confirmed. Keep the saved proof; do not create another withdrawal.`,
  )
}

export async function withdrawalInputsSpent(session: WalletSession, pending: PendingWithdrawal): Promise<boolean> {
  const inputs = withdrawalInputs(pending)
  const confirmedBlock = Math.max(0, (await session.provider.getBlockNumber()) - 1)
  const proxy = new Contract(CONFIG.proxyContract, PRIVACY, session.provider)
  const spent: boolean[] = await Promise.all(
    inputs.map((input) => proxy.getFunction('nullifiers')(input.tree, input.nullifier, { blockTag: confirmedBlock })),
  )
  return spent.some(Boolean)
}

export async function resumePendingWithdrawal(session: WalletSession, sponsor: JsonRpcSigner): Promise<string> {
  const pending = await pendingWithdrawal(session)
  if (!pending) throw new Error('No saved withdrawal to resume.')
  assertAtomicWithdrawal(pending.transaction.data)
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
