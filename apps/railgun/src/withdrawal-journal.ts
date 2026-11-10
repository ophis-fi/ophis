import { CHAIN, CHAIN_ID, isTokenSymbol, CONFIG, NATIVE_SYMBOL, TOKENS, tokenFor, PILOT_WITHDRAWAL_RECIPIENT, WRAPPED_SYMBOL, type TokenSymbol } from './config'
import { fullWalletForID, getWalletTransactionHistory } from '@railgun-community/wallet'
import { authorizationify, Contract, formatUnits, getAddress, Interface, type JsonRpcSigner, type TransactionReceipt } from 'ethers'
import { RelayAdapt7702ExecutionType } from '@railgun-community/engine'
import { ADAPT, assertAuthorization, assertAtomicWithdrawal, assertBoundWithdrawal, assertNativeExecutionBinding, assertReceipt, withdrawalOutput, PRIVACY } from './execution'
import { deletePrivateState, readPrivateState, writePrivateState } from './storage'
import type { WalletSession } from './wallet'
import { assertPublicNetwork } from './shield'
import { feeTokenFor } from './fee-asset'

export interface PendingWithdrawal {
  chainId?: number
  token: TokenSymbol
  feeToken?: TokenSymbol
  feeMode?: 'prepaid'
  broadcaster?: string
  output?: 'native'
  execution?: { index: number; account: string; executeNonce: string;
    authorization: { address: string; chainId: string; nonce: string; signature: string };
    gasEstimate: string; maxFeePerGas: string; maxPriorityFeePerGas: string }
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
    ('feeToken' in stored && !isTokenSymbol(stored.feeToken)) ||
    ('feeMode' in stored && stored.feeMode !== 'prepaid') ||
    ('output' in stored && stored.output !== 'native') ||
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
  const pending = stored as PendingWithdrawal
  if (pending.output === 'native' && !pending.execution) throw new Error('Native withdrawal requires its saved signed execution.')
  if (pending.execution) {
    const e = pending.execution
    if (pending.feeToken !== (pending.feeMode === 'prepaid' ? WRAPPED_SYMBOL : feeTokenFor(pending.token)) || typeof pending.broadcaster !== 'string' ||
      !Number.isSafeInteger(e.index) || e.index < 0 || typeof e.account !== 'string' ||
      getAddress(e.account) !== getAddress(pending.transaction.to) ||
      ![e.executeNonce, e.gasEstimate, e.maxFeePerGas, e.maxPriorityFeePerGas].every((n) => typeof n === 'string' && /^\d+$/.test(n)) ||
      BigInt(e.gasEstimate) <= 0n || BigInt(e.maxPriorityFeePerGas) <= 0n || BigInt(e.maxPriorityFeePerGas) > BigInt(e.maxFeePerGas))
      throw new Error('Saved withdrawal execution is damaged. Keep its proof and recovery account.')
    const checked = assertBoundWithdrawal(pending.transaction.data, e.account, pending.token, pending.recipient, BigInt(pending.minimum), pending.output, pending.feeMode)
    if (checked.executeNonce !== BigInt(e.executeNonce)) throw new Error('Saved withdrawal nonce differs from its signature.')
    const [transactions, actionData, , executionSignature] = ADAPT.decodeFunctionData('execute', pending.transaction.data)
    assertAuthorization({ transactions, actionData, executionSignature, ephemeralAddress: e.account,
      authorization: authorizationify(e.authorization), executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: BigInt(e.executeNonce) })
  } else if (getAddress(pending.transaction.to) !== getAddress(CONFIG.proxyContract)) throw new Error('Pending withdrawal record is damaged.')
  return stored as PendingWithdrawal
}

export async function savePendingWithdrawal(session: WalletSession, pending: PendingWithdrawal): Promise<void> {
  if (pending.chainId !== undefined && pending.chainId !== CHAIN_ID) throw new Error('Pending withdrawal network changed.')
  await writePrivateState(session, 'pendingWithdrawal', { ...pending, chainId: CHAIN_ID })
}

export function savedWithdrawalSummary(pending: PendingWithdrawal): string {
  const asset = tokenFor(pending.token)
  if (pending.execution) return `Saved withdrawal: ${formatUnits(pending.minimum, asset.decimals)} ${pending.output === 'native' ? NATIVE_SYMBOL : asset.symbol}${pending.token.startsWith('0x') ? ` (${asset.address})` : ''} to ${pending.recipient}; broadcaster fee in ${tokenFor(pending.feeToken ?? feeTokenFor(pending.token)).symbol}. Recovery account ${pending.execution.index}: ${pending.execution.account}\nPublic wallet resume requires support for externally signed EIP-7702 authorizations; some wallets reject these requests. Broadcaster retry and authorization invalidation remain available.`
  const note = withdrawalOutput(pending.transaction.data)
  const listedAsset = Object.values(TOKENS).find((item) => getAddress(item.address) === getAddress(note.token.tokenAddress))
  const amount = listedAsset ? `${formatUnits(note.value, listedAsset.decimals)} ${listedAsset.symbol}` : `unknown token ${note.token.tokenAddress}`
  const format = BigInt(note.token.tokenType) === 0n && BigInt(note.token.tokenSubID) === 0n ? '' : ' (unsupported token format)'
  return `Saved withdrawal: ${amount}${format} to ${pending.recipient}${pending.feeToken ? `; broadcaster fee in ${pending.feeToken}` : ''}`
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

function withdrawalTransactions(pending: PendingWithdrawal) {
  return pending.execution ? ADAPT.decodeFunctionData('execute', pending.transaction.data)[0] : PRIVACY.decodeFunctionData('transact', pending.transaction.data)[0]
}

function withdrawalInputs(pending: PendingWithdrawal) {
  const transactions = withdrawalTransactions(pending)
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
  let output = events.reduce(
    (sum, event) =>
      event?.name === 'Unshield' &&
      getAddress(event.args.to) === getAddress(pending.recipient) &&
      getAddress(event.args.token.tokenAddress) === getAddress(tokenFor(pending.token).address)
        ? sum + BigInt(event.args.amount)
        : sum,
    0n,
  )
  if (pending.execution) {
    assertReceipt(receipt, pending.execution.account)
    if (pending.output === 'native') {
      assertBoundWithdrawal(pending.transaction.data, pending.execution.account, pending.token, pending.recipient, BigInt(pending.minimum), 'native', pending.feeMode)
      const unshielded = events.reduce((sum, event) => event?.name === 'Unshield' &&
        getAddress(event.args.to) === getAddress(pending.execution!.account) &&
        getAddress(event.args.token.tokenAddress) === getAddress(tokenFor('WBNB').address) ? sum + BigInt(event.args.amount) : sum, 0n)
      const wrapper = new Interface(['event Withdrawal(address indexed src,uint256 wad)'])
      const unwrapped = receipt.logs.filter((log) => getAddress(log.address) === getAddress(tokenFor('WBNB').address)).reduce((sum, log) => {
        let event
        try { event = wrapper.parseLog({ topics: [...log.topics], data: log.data }) } catch { return sum }
        return event && getAddress(event.args.src) === getAddress(pending.execution!.account) ? sum + BigInt(event.args.wad) : sum
      }, 0n)
      const proof = withdrawalTransactions(pending)[0]
      const prepaidFullUnshield = pending.feeMode === 'prepaid' && proof.commitments.length === 1 &&
        proof.boundParams.commitmentCiphertext.length === 0
      if (unshielded !== BigInt(pending.minimum) || unwrapped !== BigInt(pending.minimum) ||
        (!prepaidFullUnshield && !events.some((event) => event?.name === 'Transact' && [...event.args.hash].includes(proof.commitments[0]))))
        throw new Error('Native withdrawal unshield, unwrap and fee commitment are not confirmed.')
      // Native transfer has no ERC20 event. Reconciliation also verifies the
      // actual transaction and canonical delegate/guard before clearing.
      output = unwrapped
    } else {
      const token = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)'])
      output = receipt.logs.filter((log) => getAddress(log.address) === getAddress(tokenFor(pending.token).address)).reduce((sum, log) => {
        let event
        try { event = token.parseLog({ topics: [...log.topics], data: log.data }) } catch { return sum }
        return event && getAddress(event.args.from) === getAddress(pending.execution!.account) &&
          getAddress(event.args.to) === getAddress(pending.recipient) ? sum + BigInt(event.args.value) : sum
      }, 0n)
    }
  }
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
          (amount) => amount.recipientAddress && getAddress(amount.recipientAddress) === getAddress(pending.execution?.account ?? pending.recipient),
        ),
    )
    .map((item) => (item.txid.startsWith('0x') ? item.txid : `0x${item.txid}`))
  const candidates = [...new Set([...(pending.hash ? [pending.hash] : []), ...history])]
  for (const hash of candidates) {
    const receipt = await session.provider.getTransactionReceipt(hash)
    if (!receipt || (await receipt.confirmations()) < 2) continue
    try {
      assertWithdrawalReceipt(receipt, pending)
      if (pending.output === 'native') await assertNativeExecutionBinding(session, receipt, pending, hash)
    } catch {
      continue
    }
    if (pending.execution)
      await fullWalletForID(session.info.id).setEphemeralKeyIndexIfGreater(CHAIN, pending.execution.index + 1)
    await deletePrivateState(session, 'pendingWithdrawal')
    return `Withdrawal confirmed: ${hash}`
  }
  const spent = await withdrawalInputStates(session, pending)
  let offset = 0
  const proofsDead: boolean[] = [...withdrawalTransactions(pending)].map((tx) => {
    const dead = spent.slice(offset, offset + tx.nullifiers.length).some(Boolean)
    offset += tx.nullifiers.length
    return dead
  })
  if (spent.some(Boolean) && (!proofsDead.every(Boolean) || pending.execution))
    throw new Error(`Withdrawal inputs were spent without a confirmed recipient output. The complete saved proof is preserved.${pending.execution ? ` Check recovery account ${pending.execution.index} (${pending.execution.account}); invalidate its authorization before clearing.` : ' Remaining principal proofs must be recovered before clearing.'}`)
  if (proofsDead.every(Boolean)) {
    await deletePrivateState(session, 'pendingWithdrawal')
    return 'Saved withdrawal proof is no longer executable: an input was spent. Check wallet history for the actual outcome; this does not confirm the requested output.'
  }
  throw new Error(
    `${savedWithdrawalSummary(pending)}\nWithdrawal is not confirmed. Keep the saved proof; do not create another withdrawal.`,
  )
}

export async function withdrawalInputsSpent(session: WalletSession, pending: PendingWithdrawal): Promise<boolean> {
  return (await withdrawalInputStates(session, pending)).some(Boolean)
}

async function withdrawalInputStates(session: WalletSession, pending: PendingWithdrawal): Promise<boolean[]> {
  const inputs = withdrawalInputs(pending)
  const confirmedBlock = Math.max(0, (await session.provider.getBlockNumber()) - 1)
  const proxy = new Contract(CONFIG.proxyContract, PRIVACY, session.provider)
  const spent: boolean[] = await Promise.all(
    inputs.map((input) => proxy.getFunction('nullifiers')(input.tree, input.nullifier, { blockTag: confirmedBlock })),
  )
  return spent
}

export async function resumePendingWithdrawal(session: WalletSession, sponsor: JsonRpcSigner,
  beforeSend: () => void = () => {}): Promise<string> {
  const pending = await pendingWithdrawal(session)
  if (!pending) throw new Error('No saved withdrawal to resume.')
  if (pending.execution) {
    if (await withdrawalInputsSpent(session, pending)) throw new Error('A saved input is spent. Check the recovery account before retrying.')
    await assertPublicNetwork(session, sponsor, beforeSend)
    const e = pending.execution
    const sent = await sponsor.sendTransaction({ ...pending.transaction, value: 0n, type: 4, chainId: CHAIN,
      authorizationList: [authorizationify(e.authorization)], maxFeePerGas: BigInt(e.maxFeePerGas), maxPriorityFeePerGas: BigInt(e.maxPriorityFeePerGas) }).catch((error: unknown) => {
      // Match an explicit wallet rejection, including ethers' RPC error wrappers.
      // Atomic wallet_sendCalls capability does not establish support for this request.
      const detail = error as { message?: unknown; error?: { message?: unknown }; info?: { error?: { message?: unknown } } } | null
      if ([detail?.message, detail?.error?.message, detail?.info?.error?.message].some((message) =>
        typeof message === 'string' && message.includes('External EIP-7702 transactions are not supported')))
        throw new Error('This public wallet rejects externally signed EIP-7702 authorizations. The complete saved proof is preserved. Retry through the broadcaster, resume with a compatible public wallet, or invalidate the saved authorization.', { cause: error })
      throw error
    })
    await savePendingWithdrawal(session, { ...pending, hash: sent.hash })
    if (!await sent.wait(2)) throw new Error('Withdrawal confirmation is pending. Keep the saved record.')
    return reconcilePendingWithdrawal(session)
  }
  assertAtomicWithdrawal(pending.transaction.data)
  // Reusing the exact proof cannot withdraw twice: its nullifiers can only be spent once.
  await assertPublicNetwork(session, sponsor)
  const fees = await session.provider.getFeeData()
  await assertPublicNetwork(session, sponsor, beforeSend)
  if (CHAIN_ID === 56) {
    const gasPrice = BigInt(pending.minGasPrice) > (fees.gasPrice || 0n) ? BigInt(pending.minGasPrice) : fees.gasPrice || 0n
    if (gasPrice <= 0n) throw new Error('BNB Chain gas price unavailable.')
    const sent = await sponsor.sendTransaction({ ...pending.transaction, value: BigInt(pending.transaction.value), chainId: CHAIN, type: 0, gasPrice })
    await savePendingWithdrawal(session, { ...pending, hash: sent.hash })
    if (!await sent.wait(2)) throw new Error('Withdrawal confirmation is pending. Keep the saved record.')
    return reconcilePendingWithdrawal(session)
  }
  const maxPriorityFeePerGas =
    BigInt(pending.minGasPrice) > (fees.maxPriorityFeePerGas || 0n)
      ? BigInt(pending.minGasPrice)
      : fees.maxPriorityFeePerGas || 0n
  const maxFeePerGas =
    maxPriorityFeePerGas * 2n > (fees.maxFeePerGas || 0n) ? maxPriorityFeePerGas * 2n : fees.maxFeePerGas || 0n
  const sent = await sponsor.sendTransaction({
    ...pending.transaction,
    value: BigInt(pending.transaction.value),
    chainId: CHAIN,
    type: 2,
    maxPriorityFeePerGas,
    maxFeePerGas,
  })
  await savePendingWithdrawal(session, { ...pending, hash: sent.hash })
  const receipt = await sent.wait(2)
  if (!receipt) throw new Error('Withdrawal confirmation is pending. Keep the saved record.')
  return reconcilePendingWithdrawal(session)
}
