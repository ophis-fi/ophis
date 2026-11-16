import { fullWalletForID } from '@railgun-community/wallet'
import { authorizationify, getAddress, Interface, isHexString, Signature, verifyAuthorization, ZeroAddress,
  Transaction, type HDNodeWallet, type JsonRpcSigner, type TransactionReceipt, type TransactionRequest } from 'ethers'
import { CHAIN, CHAIN_ID, CONFIG } from './config'
import { readPrivateState, writePrivateState, deletePrivateState } from './storage'
import { assertPublicNetwork } from './shield'
import type { WalletSession } from './wallet'
import { quoteBaseSetupFees, quoteBaseRefundFees, type BaseSetupFeeQuote } from './base-setup-fees'

const KEY = 'baseExecutionSetup'
const NONCE = new Interface(['function nonce() view returns (uint256)'])
const REGISTRY = new Interface(['function getContractAddress(string) view returns (address)'])
const busy = new WeakSet<WalletSession>()
export interface LegacyBaseExecutionSetup {
  version: 1; account: string; index: number; payer: string; payerNonce: number; createdAt: number
  authorization: { address: string; chainId: string; nonce: string; signature: string }
  gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string
  hash?: string; confirmedHash?: string; confirmed?: boolean; cancelled?: boolean; used?: boolean
}

async function currentDelegation(session: WalletSession, account: string, expectedNonce = 1): Promise<{ ready: boolean; nonce: number }> {
  if (CHAIN_ID !== 8453 || (await session.provider.getNetwork()).chainId !== CHAIN)
    throw new Error('Base execution setup requires the selected Base network.')
  const head = await session.provider.getBlock('latest')
  if (!head?.hash) throw new Error('Base setup confirmation is unavailable.')
  const [code, nonce, pendingNonce] = await Promise.all([
    session.provider.getCode(account, head.number), session.provider.getTransactionCount(account, head.number),
    session.provider.getTransactionCount(account, 'pending'),
  ])
  const expected = `0xef0100${CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}`
  if (code.toLowerCase() !== expected || nonce !== expectedNonce || pendingNonce !== nonce) return { ready: false, nonce }
  const executionNonce = NONCE.decodeFunctionResult('nonce', await session.provider.call({ to: account,
    data: NONCE.encodeFunctionData('nonce'), blockTag: head.number }))[0]
  if ((await session.provider.getBlock(head.number))?.hash !== head.hash)
    throw new Error('Base setup history changed. Check again before preparing an operation.')
  return { ready: executionNonce === 0n, nonce }
}

export async function baseAccountPrepared(session: WalletSession, account: string): Promise<boolean> {
  const setup = await savedBaseExecutionSetup(session)
  if (!setup?.confirmed || setup.used || isRetired(setup) || setup.account !== getAddress(account)) return false
  const ready = (await currentDelegation(session, account, setup.version === 2 ? 2 : 1)).ready
  const fresh = await savedBaseExecutionSetup(session)
  return ready && !!fresh?.confirmed && !fresh.used && !isRetired(fresh) && fresh.account === setup.account
}

export async function requireBaseExecutionSetup(session: WalletSession, account: string): Promise<void> {
  const setup = await savedBaseExecutionSetup(session)
  if (busy.has(session) || !setup?.confirmed || isRetired(setup) || setup.account !== getAddress(account) ||
    !(await currentDelegation(session, account, setup.version === 2 ? 2 : 1)).ready)
    throw new Error('Prepare this Base execution account with your public wallet before reviewing the swap or withdrawal.')
  const fresh = await savedBaseExecutionSetup(session)
  if (!fresh?.confirmed || isRetired(fresh) || fresh.account !== setup.account) throw new Error('The Base setup changed during its check.')
}

export async function markBaseExecutionSetupUsed(session: WalletSession, account: string): Promise<void> {
  await exclusive(session, async () => {
    const setup = await savedBaseExecutionSetup(session)
    if (!setup?.confirmed || isRetired(setup) || setup.account !== getAddress(account)) throw new Error('The Base execution setup journal changed.')
    if (!setup.used) await saveSetup(session, { ...setup, used: true })
  })
}

function setupTransaction(setup: LegacyBaseExecutionSetup): TransactionRequest {
  return { to: ZeroAddress, data: '0x', value: 0n, type: 4, chainId: CHAIN, nonce: setup.payerNonce,
    authorizationList: [authorizationify(setup.authorization)], gasLimit: BigInt(setup.gasLimit),
    maxFeePerGas: BigInt(setup.maxFeePerGas), maxPriorityFeePerGas: BigInt(setup.maxPriorityFeePerGas) }
}

async function validate(session: WalletSession, value: unknown): Promise<LegacyBaseExecutionSetup> {
  const setup = value as LegacyBaseExecutionSetup
  if (CHAIN_ID !== 8453 || !setup || setup.version !== 1 || !Number.isSafeInteger(setup.index) || setup.index < 0 ||
    !Number.isSafeInteger(setup.payerNonce) || setup.payerNonce < 0 || !Number.isSafeInteger(setup.createdAt) ||
    ![setup.gasLimit, setup.maxFeePerGas, setup.maxPriorityFeePerGas].every(v => typeof v === 'string' && /^[1-9][0-9]{0,20}$/.test(v)) ||
    BigInt(setup.gasLimit) > 100_000n || BigInt(setup.maxPriorityFeePerGas) > BigInt(setup.maxFeePerGas) ||
    (setup.hash !== undefined && !isHexString(setup.hash, 32)) ||
    (setup.confirmedHash !== undefined && !isHexString(setup.confirmedHash, 32)) ||
    (setup.confirmed !== undefined && setup.confirmed !== true) || (setup.cancelled !== undefined && setup.cancelled !== true) ||
    (setup.used !== undefined && setup.used !== true) ||
    (setup.confirmed && setup.cancelled)) throw new Error('Invalid saved Base setup. Preserve its recovery data.')
  const authorization = authorizationify(setup.authorization)
  if (authorization.chainId !== CHAIN || authorization.nonce !== 0n ||
    getAddress(authorization.address) !== getAddress(CONFIG.relayAdapt7702Contract) ||
    getAddress(verifyAuthorization(authorization, authorization.signature)) !== getAddress(setup.account) ||
    getAddress((await session.accounts.getAccount(CHAIN, setup.index)).address) !== getAddress(setup.account) ||
    getAddress(setup.payer) === getAddress(setup.account) || getAddress(setup.payer) === ZeroAddress)
    throw new Error('The saved Base setup differs from its execution account or delegate.')
  return setup
}

async function submitLegacyBaseExecutionSetup(session: WalletSession, signer: JsonRpcSigner, reviewed: LegacyBaseExecutionSetup,
  beforeSend: () => void = () => {}): Promise<string> {
  if (busy.has(session)) throw new Error('A Base setup is already in progress.')
  busy.add(session)
  try {
    const setup = await validate(session, reviewed), existing = await savedBaseExecutionSetup(session)
    if ((existing && !existing.confirmed && !existing.cancelled) || setup.hash || setup.confirmed || setup.cancelled ||
      Date.now() - setup.createdAt > 120_000 || Date.now() < setup.createdAt)
      throw new Error('Check the saved Base setup or review a fresh setup before signing.')
    await assertPublicNetwork(session, signer, beforeSend)
    if (getAddress(await signer.getAddress()) !== setup.payer || await signer.provider.getTransactionCount(setup.payer, 'pending') !== setup.payerNonce ||
      (await session.accounts.getCurrentAccount(CHAIN)).address !== setup.account ||
      await session.provider.getCode(setup.account) !== '0x' || await session.provider.getTransactionCount(setup.account, 'pending') !== 0)
      throw new Error('The setup wallet, nonce or execution account changed. Review it again.')
    await writePrivateState(session, KEY, setup)
    try { beforeSend() } catch (error) { await deletePrivateState(session, KEY); throw error }
    let sent
    try {
      sent = await signer.sendTransaction(setupTransaction(setup))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error.code === 'ACTION_REJECTED' || error.code === 4001))
        await deletePrivateState(session, KEY)
      throw error
    }
    if (!isHexString(sent.hash, 32)) throw new Error('Setup submission outcome is unknown. Check your public wallet transaction history.')
    await writePrivateState(session, KEY, { ...setup, hash: sent.hash })
    return sent.hash
  } finally { busy.delete(session) }
}

async function checkLegacyBaseExecutionSetup(session: WalletSession, suppliedHash?: string, index?: number): Promise<{ hash: string; ready: boolean }> {
  const setup = await savedBaseExecutionSetup(session, index)
  if (!setup || setup.version !== 1) throw new Error('No legacy Base setup is saved.')
  if ((await session.provider.getNetwork()).chainId !== CHAIN) throw new Error('Base setup recovery requires the selected Base network.')
  const hash = suppliedHash || setup.confirmedHash || setup.hash
  if (!hash || !isHexString(hash, 32))
    throw new Error('Copy the setup transaction hash from your public wallet. Do not send another setup transaction.')
  const [tx, receipt, head] = await Promise.all([session.provider.getTransaction(hash), session.provider.getTransactionReceipt(hash),
    session.provider.getBlock('latest')])
  if (!receipt || !tx || !head || receipt.hash.toLowerCase() !== hash.toLowerCase() || tx.hash.toLowerCase() !== hash.toLowerCase() ||
    tx.blockNumber !== receipt.blockNumber || tx.blockHash !== receipt.blockHash || head.number < receipt.blockNumber + 1 ||
    (await session.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash)
    throw new Error('Base setup needs two canonical confirmations. Keep its saved transaction.')
  const authorization = tx.authorizationList?.[0]
  if (tx.type === 2 && tx.chainId === CHAIN && tx.nonce === setup.payerNonce && getAddress(tx.from) === setup.payer &&
    tx.to && getAddress(tx.to) === setup.payer && tx.data === '0x' && tx.value === 0n && !tx.authorizationList?.length && receipt.status === 1) {
    const finalized = await session.provider.getBlock('finalized')
    if (!finalized || finalized.number < receipt.blockNumber ||
      await session.provider.getCode(setup.account) !== '0x' || await session.provider.getTransactionCount(setup.account, 'pending') !== 0 ||
      (await session.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash)
      throw new Error('Wait for the cancelled setup nonce to finalize before preparing another setup.')
    await writePrivateState(session, KEY, { ...setup, confirmed: undefined, cancelled: true, confirmedHash: hash })
    return { hash, ready: false }
  }
  if (tx.type !== 4 || tx.chainId !== CHAIN || tx.nonce !== setup.payerNonce || getAddress(tx.from) !== setup.payer ||
    tx.to !== ZeroAddress || tx.data !== '0x' || tx.value !== 0n || tx.authorizationList?.length !== 1 || !authorization ||
    authorization.chainId !== CHAIN || authorization.nonce !== 0n ||
    getAddress(authorization.address) !== getAddress(CONFIG.relayAdapt7702Contract) ||
    getAddress(verifyAuthorization(authorization, authorization.signature)) !== setup.account ||
    (receipt.status !== 0 && receipt.status !== 1)) throw new Error('The setup receipt does not match its saved authorization.')
  if (!(await currentDelegation(session, setup.account)).ready) throw new Error('The Base setup did not install an unused canonical delegation.')
  await writePrivateState(session, KEY, { ...setup, hash: setup.hash ?? hash, confirmedHash: hash, confirmed: true, cancelled: undefined })
  return { hash, ready: true }
}

const BOOK = 'baseExecutionSetupsV2'
export interface FundedBaseExecutionSetup extends Omit<LegacyBaseExecutionSetup, 'version'> {
  version: 2
  fundingAmount: string
  feeQuote: BaseSetupFeeQuote
  fundingHash?: string
  fundingNonce?: number
  fundingConfirmedHash?: string
  funded?: true
  signedTransaction?: string
  retired?: true
  refund?: SavedBaseSetupRefund
  refundHistory?: SavedBaseSetupRefund[]
}
export type BaseExecutionSetup = LegacyBaseExecutionSetup | FundedBaseExecutionSetup
interface SetupBook { version: 1; activeIndex: number; records: Record<string, FundedBaseExecutionSetup> }
export interface BaseSetupRefund {
  index: number; account: string; payer: string; nonce: number; balance: string; value: string; feeQuote: BaseSetupFeeQuote
  cancelsSetup?: true
}
interface SavedBaseSetupRefund extends BaseSetupRefund { signedTransaction: string; hash: string; confirmed?: true; failed?: true; superseded?: true }
export interface BaseSetupStatus { hash?: string; ready: boolean; funded?: boolean; lateFundingPossible?: true; stage: 'funding' | 'setup' | 'cancelled' }
const isRetired = (setup: BaseExecutionSetup) => setup.version === 2 && !!setup.retired
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const quantity = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v)

async function exclusive<T>(session: WalletSession, action: () => Promise<T>): Promise<T> {
  if (busy.has(session)) throw new Error('A Base setup or recovery is already in progress.')
  busy.add(session)
  try { return await action() } finally { busy.delete(session) }
}
async function bookFor(session: WalletSession): Promise<SetupBook | undefined> {
  const value = await readPrivateState(session, BOOK) as SetupBook | undefined
  if (value === undefined) return undefined
  if (!value || value.version !== 1 || !integer(value.activeIndex) || !value.records || typeof value.records !== 'object' ||
    Array.isArray(value.records) || !Object.hasOwn(value.records, String(value.activeIndex)) ||
    Object.keys(value.records).some(k => !/^(0|[1-9][0-9]{0,6})$/.test(k) || Number(k) > 1_000_000))
    throw new Error('Base setup recovery records are damaged. Preserve the wallet data.')
  return value
}
function validateQuote(quote: BaseSetupFeeQuote): void {
  if (!quote || !integer(quote.createdAt) || !integer(quote.blockNumber) || !isHexString(quote.blockHash, 32) || !isHexString(quote.unsignedHash, 32) ||
    quote.feeBound !== 'estimate-only' || ![quote.gasLimit, quote.maxFeePerGas, quote.maxPriorityFeePerGas,
      quote.executionMaximum, quote.l1FeeEstimate, quote.operatorFeeEstimate, quote.maximumNetworkFee].every(quantity) ||
    BigInt(quote.gasLimit) <= 0n || BigInt(quote.gasLimit) > 100_000n || BigInt(quote.maxFeePerGas) <= 0n ||
    BigInt(quote.maxFeePerGas) > 100_000_000n || BigInt(quote.maxPriorityFeePerGas) <= 0n || BigInt(quote.maxPriorityFeePerGas) > BigInt(quote.maxFeePerGas) ||
    BigInt(quote.executionMaximum) !== BigInt(quote.gasLimit) * BigInt(quote.maxFeePerGas) ||
    BigInt(quote.maximumNetworkFee) < BigInt(quote.executionMaximum) + BigInt(quote.l1FeeEstimate) + BigInt(quote.operatorFeeEstimate) ||
    BigInt(quote.maximumNetworkFee) > 10_000_000_000_000n)
    throw new Error('The saved Base fee review is invalid.')
}
function localSetupTransaction(setup: FundedBaseExecutionSetup): TransactionRequest {
  return { from: setup.account, to: ZeroAddress, chainId: CHAIN, type: 4, nonce: 0, data: '0x', value: 0n,
    authorizationList: [authorizationify(setup.authorization)], gasLimit: BigInt(setup.gasLimit),
    maxFeePerGas: BigInt(setup.maxFeePerGas), maxPriorityFeePerGas: BigInt(setup.maxPriorityFeePerGas) }
}
function refundTransaction(refund: BaseSetupRefund): TransactionRequest {
  return { type: 2, chainId: CHAIN, nonce: refund.nonce, from: refund.account, to: refund.payer, data: '0x',
    value: BigInt(refund.value), gasLimit: BigInt(refund.feeQuote.gasLimit), maxFeePerGas: BigInt(refund.feeQuote.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(refund.feeQuote.maxPriorityFeePerGas) }
}
function unsignedTransaction(expected: TransactionRequest): Transaction {
  return Transaction.from({ type: Number(expected.type), chainId: BigInt(String(expected.chainId)),
    nonce: Number(expected.nonce), to: getAddress(String(expected.to)), data: String(expected.data), value: BigInt(String(expected.value ?? 0)),
    gasLimit: BigInt(String(expected.gasLimit)), maxFeePerGas: BigInt(String(expected.maxFeePerGas)),
    maxPriorityFeePerGas: BigInt(String(expected.maxPriorityFeePerGas)),
    ...(expected.authorizationList ? { authorizationList: expected.authorizationList.map(authorizationify) } : {}) })
}
function assertSigned(raw: string, expected: TransactionRequest, hash?: string): Transaction {
  if (!isHexString(raw) || raw.length > 16_384) throw new Error('Invalid saved signed setup transaction.')
  const tx = Transaction.from(raw), target = unsignedTransaction(expected)
  if (!tx.signature || tx.from !== getAddress(String(expected.from)) || tx.unsignedSerialized !== target.unsignedSerialized ||
    (hash !== undefined && tx.hash !== hash)) throw new Error('The saved signed transaction differs from its reviewed action.')
  return tx
}
async function validateV2(session: WalletSession, setup: FundedBaseExecutionSetup): Promise<FundedBaseExecutionSetup> {
  if (CHAIN_ID !== 8453 || !setup || setup.version !== 2 || !integer(setup.index) || setup.index > 1_000_000 ||
    !integer(setup.payerNonce) || !integer(setup.createdAt) || setup.gasLimit !== '46000' ||
    (setup.fundingNonce !== undefined && !integer(setup.fundingNonce)) ||
    ![setup.fundingAmount, setup.maxFeePerGas, setup.maxPriorityFeePerGas].every(quantity) || BigInt(setup.fundingAmount) <= 0n ||
    BigInt(setup.fundingAmount) > 10_000_000_000_000n ||
    [setup.hash, setup.confirmedHash, setup.fundingHash, setup.fundingConfirmedHash].some(h => h !== undefined && !isHexString(h, 32)) ||
    [setup.funded, setup.confirmed, setup.cancelled, setup.used, setup.retired].some(v => v !== undefined && v !== true) ||
    (setup.confirmed && setup.cancelled)) throw new Error('Invalid saved Base funding setup. Preserve its recovery data.')
  validateQuote(setup.feeQuote)
  if (setup.gasLimit !== setup.feeQuote.gasLimit || setup.maxFeePerGas !== setup.feeQuote.maxFeePerGas ||
    setup.maxPriorityFeePerGas !== setup.feeQuote.maxPriorityFeePerGas || setup.fundingAmount !== setup.feeQuote.maximumNetworkFee ||
    unsignedTransaction(localSetupTransaction(setup)).unsignedHash !== setup.feeQuote.unsignedHash)
    throw new Error('The saved setup fee allocation changed.')
  const account = await session.accounts.getAccount(CHAIN, setup.index), authorization = authorizationify(setup.authorization)
  if (getAddress(account.address) !== getAddress(setup.account) || getAddress(setup.payer) === getAddress(setup.account) ||
    getAddress(setup.payer) === ZeroAddress || authorization.chainId !== CHAIN || authorization.nonce !== 1n ||
    getAddress(authorization.address) !== getAddress(CONFIG.relayAdapt7702Contract) ||
    getAddress(verifyAuthorization(authorization, authorization.signature)) !== getAddress(setup.account))
    throw new Error('The saved Base funding account, payer or authorization changed.')
  if (setup.signedTransaction) assertSigned(setup.signedTransaction, localSetupTransaction(setup), setup.hash)
  if ((setup.hash && !setup.signedTransaction) || (setup.confirmed && (!setup.signedTransaction || !setup.confirmedHash)) ||
    (setup.funded && !setup.fundingConfirmedHash)) throw new Error('The saved Base setup evidence is incomplete.')
  for (const refund of [...(setup.refundHistory ?? []), ...(setup.refund ? [setup.refund] : [])]) {
    validateQuote(refund.feeQuote)
    if (unsignedTransaction(refundTransaction(refund)).unsignedHash !== refund.feeQuote.unsignedHash) throw new Error('The return fee review changed.')
    if (refund.index !== setup.index || refund.account !== setup.account || refund.payer !== setup.payer ||
      (refund.cancelsSetup !== undefined && (refund.cancelsSetup !== true || refund.nonce !== 0 || !setup.signedTransaction || setup.used)) ||
      !integer(refund.nonce) || !quantity(refund.balance) || !quantity(refund.value) || BigInt(refund.value) <= 0n ||
      BigInt(refund.value) + BigInt(refund.feeQuote.maximumNetworkFee) > BigInt(refund.balance) ||
      !isHexString(refund.hash, 32) || [refund.confirmed, refund.failed, refund.superseded].some(v => v !== undefined && v !== true) ||
      ((refund.failed || refund.superseded) && !refund.confirmed) || !setup.retired)
      throw new Error('The saved Base remainder recovery is damaged.')
    assertSigned(refund.signedTransaction, refundTransaction(refund), refund.hash)
  }
  return setup
}
export async function savedBaseExecutionSetup(session: WalletSession, index?: number): Promise<BaseExecutionSetup | undefined> {
  if (index !== undefined && (!integer(index) || index > 1_000_000)) throw new Error('Invalid Base recovery account index.')
  const book = await bookFor(session)
  if (book && (index === undefined || Object.hasOwn(book.records, String(index)))) {
    const selected = index ?? book.activeIndex, record = book.records[String(selected)]
    if (record?.index !== selected) throw new Error('Base recovery index differs from its archived record.')
    return validateV2(session, record)
  }
  const old = await readPrivateState(session, KEY)
  const legacy = old === undefined ? undefined : await validate(session, old)
  return index === undefined || legacy?.index === index ? legacy : undefined
}
async function saveSetup(session: WalletSession, setup: BaseExecutionSetup, makeActive = false): Promise<void> {
  if (setup.version === 1) { await writePrivateState(session, KEY, setup); return }
  await validateV2(session, setup)
  const book = await bookFor(session)
  await writePrivateState(session, BOOK, { version: 1, activeIndex: makeActive || !book ? setup.index : book.activeIndex,
    records: { ...book?.records, [String(setup.index)]: setup } })
}
export async function listBaseSetupRecoveryIndices(session: WalletSession): Promise<number[]> {
  const book = await bookFor(session)
  return book ? Object.keys(book.records).map(Number).sort((a, b) => b - a) : []
}
export async function isBaseSetupAccountReserved(session: WalletSession, account: string): Promise<boolean> {
  const book = await bookFor(session)
  if (book && Object.values(book.records).some(record => getAddress(record.account) === getAddress(account))) return true
  // A cancelled legacy request may already have disclosed its nonce-zero authorization.
  const old = await readPrivateState(session, KEY)
  return old !== undefined && getAddress((await validate(session, old)).account) === getAddress(account)
}
async function assertChain(session: WalletSession): Promise<void> {
  if (CHAIN_ID !== 8453 || (await session.provider.getNetwork()).chainId !== CHAIN) throw new Error('Base network is required.')
}
async function assertFresh(session: WalletSession, account: string, empty: boolean): Promise<void> {
  await assertChain(session)
  const head = await session.provider.getBlock('latest')
  if (!head?.hash) throw new Error('Base setup history is unavailable.')
  const [code, nonce, pending, balance] = await Promise.all([session.provider.getCode(account, head.number),
    session.provider.getTransactionCount(account, head.number), session.provider.getTransactionCount(account, 'pending'),
    session.provider.getBalance(account, head.number)])
  if (code !== '0x' || nonce !== 0 || pending !== 0 || (empty && balance !== 0n) ||
    (await session.provider.getBlock(head.number))?.hash !== head.hash)
    throw new Error('The execution account is not fresh. Keep its saved funding and recovery records.')
  const registered = REGISTRY.decodeFunctionResult('getContractAddress', await session.provider.call({ to: CONFIG.railgunRegistryContract,
    data: REGISTRY.encodeFunctionData('getContractAddress', ['RelayAdapt7702']), blockTag: head.number }))[0]
  if (getAddress(registered) !== getAddress(CONFIG.relayAdapt7702Contract)) throw new Error('The Base delegate registry changed.')
}
async function quoteCurrent(session: WalletSession, quote: BaseSetupFeeQuote): Promise<void> {
  validateQuote(quote)
  if (Date.now() < quote.createdAt || Date.now() - quote.createdAt > 120_000 ||
    (await session.provider.getBlock(quote.blockNumber))?.hash !== quote.blockHash)
    throw new Error('The Base fee review expired or its history changed. Review it again.')
}
async function assertFundingPayer(session: WalletSession, payer: string): Promise<void> {
  const code = await session.provider.getCode(payer)
  if (code !== '0x' && !/^0xef0100[0-9a-f]{40}$/i.test(code))
    throw new Error('This wallet cannot send the direct setup payment. No payment was requested.')
}
export async function prepareBaseExecutionSetup(session: WalletSession, signer: JsonRpcSigner,
  account: { address: string; signer: Pick<HDNodeWallet, 'authorize'> }): Promise<FundedBaseExecutionSetup> {
  await assertPublicNetwork(session, signer)
  const previous = await savedBaseExecutionSetup(session)
  if (previous && !previous.used && !previous.cancelled && !isRetired(previous))
    throw new Error('A Base setup is already saved. Check that transaction before preparing another.')
  const payer = getAddress(await signer.getAddress()), address = getAddress(account.address)
  if (payer === address || payer === ZeroAddress) throw new Error('Connect your separate public wallet to fund setup gas.')
  await assertFundingPayer(session, payer)
  if (await isBaseSetupAccountReserved(session, address)) throw new Error('This execution account already has a saved setup.')
  await assertFresh(session, address, true)
  const authorization = await account.signer.authorize({ chainId: CHAIN, address: CONFIG.relayAdapt7702Contract, nonce: 1 })
  const transaction = { from: address, to: ZeroAddress, type: 4, chainId: CHAIN, nonce: 0, data: '0x', value: 0n,
    gasLimit: 46_000n, authorizationList: [authorization] }
  const feeQuote = await quoteBaseSetupFees(session.provider, transaction)
  const setup: FundedBaseExecutionSetup = { version: 2, account: address,
    index: await fullWalletForID(session.info.id).getEphemeralKeyIndex(CHAIN), payer,
    payerNonce: await signer.provider.getTransactionCount(payer, 'pending'), createdAt: Date.now(),
    authorization: { address: authorization.address, chainId: authorization.chainId.toString(), nonce: authorization.nonce.toString(),
      signature: Signature.from(authorization.signature).serialized }, fundingAmount: feeQuote.maximumNetworkFee, feeQuote,
    gasLimit: feeQuote.gasLimit, maxFeePerGas: feeQuote.maxFeePerGas, maxPriorityFeePerGas: feeQuote.maxPriorityFeePerGas }
  return validateV2(session, setup)
}
export async function submitBaseExecutionSetup(session: WalletSession, signer: JsonRpcSigner, reviewed: BaseExecutionSetup,
  beforeSend: () => void = () => {}): Promise<string> {
  if (reviewed.version === 1) return submitLegacyBaseExecutionSetup(session, signer, reviewed, beforeSend)
  return exclusive(session, async () => {
    const setup = await validateV2(session, reviewed)
    if (setup.fundingHash || setup.funded || setup.signedTransaction || setup.retired ||
      await isBaseSetupAccountReserved(session, setup.account)) throw new Error('Check the saved Base funding before another request.')
    await quoteCurrent(session, setup.feeQuote)
    await assertPublicNetwork(session, signer, beforeSend)
    if (getAddress(await signer.getAddress()) !== setup.payer || await signer.provider.getTransactionCount(setup.payer, 'pending') !== setup.payerNonce ||
      getAddress((await session.accounts.getCurrentAccount(CHAIN)).address) !== setup.account)
      throw new Error('The setup payer, nonce or execution account changed.')
    await assertFundingPayer(session, setup.payer)
    await assertFresh(session, setup.account, true)
    await saveSetup(session, setup, true)
    // Once a wallet request may have escaped, retain the allocation even for an ambiguous rejection.
    try { beforeSend() } catch (error) { await saveSetup(session, { ...setup, retired: true, cancelled: true }); throw error }
    let sent
    try {
      sent = await signer.sendTransaction({ type: 2, chainId: CHAIN, nonce: setup.payerNonce, to: setup.account,
        value: BigInt(setup.fundingAmount), data: '0x' })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error.code === 'ACTION_REJECTED' || error.code === 4001))
        await saveSetup(session, { ...setup, retired: true, cancelled: true })
      throw error
    }
    if (!isHexString(sent.hash, 32)) throw new Error('Funding outcome is unknown. Check the saved payment; do not send another.')
    await saveSetup(session, { ...setup, fundingHash: sent.hash, ...(integer(sent.nonce) ? { fundingNonce: sent.nonce } : {}) })
    return sent.hash
  })
}
async function canonicalTransaction(session: WalletSession, hash: string, finalized = false, knownReceipt?: TransactionReceipt) {
  if (!isHexString(hash, 32)) throw new Error('Provide the saved transaction hash.')
  const [tx, receipt, head] = await Promise.all([session.provider.getTransaction(hash), knownReceipt ?? session.provider.getTransactionReceipt(hash),
    session.provider.getBlock(finalized ? 'finalized' : 'latest')])
  if (!tx || !receipt || !head?.hash || tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.hash.toLowerCase() !== hash.toLowerCase() ||
    tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || head.number < receipt.blockNumber + (finalized ? 0 : 1) ||
    (await session.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash)
    throw new Error(finalized ? 'Wait for this transaction to finalize. Keep its recovery record.' : 'This transaction needs two canonical confirmations. Keep its recovery record.')
  return { tx, receipt, head }
}
async function verifiedFunding(session: WalletSession, setup: FundedBaseExecutionSetup, hash: string, finalized = false) {
  const evidence = await canonicalTransaction(session, hash, finalized), { tx, receipt } = evidence
  if (receipt.status !== 1 || tx.chainId !== CHAIN || (tx.type !== 0 && tx.type !== 2) || receipt.blockNumber < setup.feeQuote.blockNumber ||
    getAddress(tx.from) !== setup.payer || !tx.to || getAddress(tx.to) !== setup.account || tx.value !== BigInt(setup.fundingAmount) ||
    tx.data !== '0x' || tx.authorizationList?.length || tx.accessList?.length)
    throw new Error('The funding receipt does not match the saved setup payment.')
  return evidence
}
async function retireEmptyFunding(session: WalletSession, setup: FundedBaseExecutionSetup): Promise<boolean> {
  if (setup.funded || setup.signedTransaction) return false
  const [finalized, latest] = await Promise.all([session.provider.getBlock('finalized'), session.provider.getBlock('latest')])
  if (!finalized?.hash || !latest?.hash || latest.number < finalized.number || finalized.number < setup.feeQuote.blockNumber ||
    await session.provider.getTransactionCount(setup.payer, finalized.number) <= Math.max(setup.payerNonce, setup.fundingNonce ?? 0)) return false
  for (const block of [finalized, latest]) {
    const [code, nonce, balance] = await Promise.all([session.provider.getCode(setup.account, block.number),
      session.provider.getTransactionCount(setup.account, block.number), session.provider.getBalance(setup.account, block.number)])
    if (code !== '0x' || nonce !== 0 || balance !== 0n) return false
  }
  if (await session.provider.getTransactionCount(setup.account, 'pending') !== 0 ||
    (await session.provider.getBlock(finalized.number))?.hash !== finalized.hash ||
    (await session.provider.getBlock(latest.number))?.hash !== latest.hash) return false
  await saveSetup(session, { ...setup, retired: true, cancelled: true })
  return true
}
export async function checkBaseExecutionSetup(session: WalletSession, suppliedHash?: string, index?: number): Promise<BaseSetupStatus> {
  const current = await savedBaseExecutionSetup(session, index)
  if (!current) throw new Error('No Base setup is saved.')
  if (current.version === 1) {
    const result = await checkLegacyBaseExecutionSetup(session, suppliedHash, index)
    return { ...result, stage: result.ready ? 'setup' : 'cancelled' }
  }
  return exclusive(session, async () => {
    await assertChain(session)
    const setup = await savedBaseExecutionSetup(session, index) as FundedBaseExecutionSetup
    if (setup.retired && setup.signedTransaction) throw new Error('This execution account is retired. Use its saved remainder recovery.')
    if (!setup.signedTransaction) {
      const hash = suppliedHash || setup.fundingConfirmedHash || setup.fundingHash
      if (!hash) {
        if (await retireEmptyFunding(session, setup)) return { ready: false, stage: 'cancelled', lateFundingPossible: true }
        throw new Error('Copy the funding transaction hash from your public wallet. Do not fund it again.')
      }
      if (!isHexString(hash, 32)) throw new Error('Provide the saved transaction hash.')
      const knownReceipt = await session.provider.getTransactionReceipt(hash)
      if (!knownReceipt) {
        if (await retireEmptyFunding(session, setup)) return { hash, ready: false, stage: 'cancelled', lateFundingPossible: true }
        throw new Error('The funding transaction has no confirmed receipt. Keep its saved record; do not fund it again.')
      }
      const candidate = await canonicalTransaction(session, hash, false, knownReceipt), { tx, receipt } = candidate
      const cancellation = (tx.type === 0 || tx.type === 2) && tx.chainId === CHAIN && setup.fundingNonce !== undefined && tx.nonce === setup.fundingNonce &&
        getAddress(tx.from) === setup.payer && tx.to && getAddress(tx.to) === setup.payer && tx.value === 0n &&
        tx.data === '0x' && !tx.authorizationList?.length && !tx.accessList?.length && receipt.status === 1
      const failedFunding = receipt.status === 0 && (tx.type === 0 || tx.type === 2) && tx.chainId === CHAIN && receipt.blockNumber >= setup.feeQuote.blockNumber &&
        getAddress(tx.from) === setup.payer && tx.to && getAddress(tx.to) === setup.account && tx.value === BigInt(setup.fundingAmount) &&
        tx.data === '0x' && !tx.authorizationList?.length && !tx.accessList?.length
      if (cancellation || failedFunding) {
        await canonicalTransaction(session, hash, true)
        await assertFresh(session, setup.account, true)
        await saveSetup(session, { ...setup, retired: true, cancelled: true, fundingHash: setup.fundingHash ?? hash })
        return { hash, ready: false, stage: 'cancelled' }
      }
      await verifiedFunding(session, setup, hash)
      await assertFresh(session, setup.account, false)
      if (await session.provider.getBalance(setup.account) < BigInt(setup.fundingAmount))
        throw new Error('The setup funding is not available in its reserved account. Keep its recovery record.')
      await saveSetup(session, { ...setup, funded: true, fundingConfirmedHash: hash, fundingNonce: tx.nonce })
      return { hash, ready: false, funded: true, stage: setup.retired ? 'cancelled' : 'funding' }
    }
    const hash = suppliedHash || setup.hash!
    if (hash !== setup.hash) throw new Error('Check the exact locally signed setup hash. No replacement was signed.')
    await verifiedFunding(session, setup, setup.fundingConfirmedHash!)
    const { tx, receipt } = await canonicalTransaction(session, hash)
    if ((receipt.status !== 0 && receipt.status !== 1) || tx.hash !== assertSigned(setup.signedTransaction, localSetupTransaction(setup)).hash ||
      !(await currentDelegation(session, setup.account, 2)).ready) throw new Error('The local setup did not install its unused canonical delegation.')
    await saveSetup(session, { ...setup, confirmed: true, confirmedHash: hash })
    return { hash, ready: true, funded: true, stage: 'setup' }
  })
}
export async function submitFundedBaseExecutionSetup(session: WalletSession, beforeSend: () => void = () => {}): Promise<string> {
  return exclusive(session, async () => {
    let setup = await savedBaseExecutionSetup(session)
    if (!setup || setup.version !== 2 || !setup.funded || !setup.fundingConfirmedHash || setup.signedTransaction || setup.retired || setup.used)
      throw new Error('Confirm the saved funding before signing this setup. Keep any existing signed transaction.')
    await verifiedFunding(session, setup, setup.fundingConfirmedHash)
    await assertFresh(session, setup.account, false)
    const fresh = await quoteBaseSetupFees(session.provider, localSetupTransaction(setup))
    if (fresh.unsignedHash !== setup.feeQuote.unsignedHash || BigInt(fresh.maximumNetworkFee) > BigInt(setup.fundingAmount) ||
      await session.provider.getBalance(setup.account) < BigInt(setup.fundingAmount))
      throw new Error('The setup allocation or estimated fee changed. Review its remaining balance; no automatic top-up was sent.')
    const head = await session.provider.getBlock('latest')
    if (!head?.hash || head.baseFeePerGas == null || head.baseFeePerGas < 0n ||
      head.baseFeePerGas + BigInt(setup.maxPriorityFeePerGas) > BigInt(setup.maxFeePerGas) ||
      (await session.provider.getBlock(head.number))?.hash !== head.hash)
      throw new Error('Base fees exceed the saved setup limit. Wait for lower fees or return the remaining gas; no setup was signed.')
    beforeSend()
    const account = await session.accounts.getAccount(CHAIN, setup.index)
    const raw = await account.signer.signTransaction(localSetupTransaction(setup)), tx = assertSigned(raw, localSetupTransaction(setup))
    setup = { ...setup, signedTransaction: raw, hash: tx.hash! }
    await saveSetup(session, setup)
    beforeSend()
    const response = await session.provider.broadcastTransaction(raw)
    if (response.hash !== setup.hash) throw new Error('Setup submission response did not match the saved signed transaction.')
    return setup.hash!
  })
}
export async function retrySignedBaseExecutionSetup(session: WalletSession): Promise<string> {
  return exclusive(session, async () => {
    await assertChain(session)
    const setup = await savedBaseExecutionSetup(session)
    if (!setup || setup.version !== 2 || !setup.signedTransaction || !setup.hash || setup.retired || setup.confirmed)
      throw new Error('No pending signed Base setup is available to retry.')
    if (await session.provider.getTransactionReceipt(setup.hash)) throw new Error('This setup has a receipt. Check its confirmation first.')
    await verifiedFunding(session, setup, setup.fundingConfirmedHash!)
    await assertFresh(session, setup.account, false)
    assertSigned(setup.signedTransaction, localSetupTransaction(setup), setup.hash)
    const sent = await session.provider.broadcastTransaction(setup.signedTransaction)
    if (sent.hash !== setup.hash) throw new Error('Setup retry response did not match its saved transaction.')
    return setup.hash
  })
}

async function noPrivatePending(session: WalletSession): Promise<void> {
  for (const key of ['pendingSwap', 'pendingWithdrawal', 'preservedWithdrawal'])
    if (await readPrivateState(session, key) !== undefined) throw new Error('Reconcile the saved private operation before recovering setup funds.')
  for (const key of ['nativePrepaidCredit', 'prepaidCredit']) {
    const saved = await readPrivateState(session, key)
    if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved) || 'attempt' in saved))
      throw new Error('Reconcile the saved prepaid attempt before recovering setup funds.')
  }
}
async function refundState(session: WalletSession, setup: FundedBaseExecutionSetup) {
  await assertChain(session)
  await noPrivatePending(session)
  const fundingHash = setup.fundingConfirmedHash || setup.fundingHash
  if (!fundingHash) throw new Error('Verify the original funding transaction before recovering its balance.')
  await verifiedFunding(session, setup, fundingHash, true)
  if (setup.refund && !setup.refund.confirmed) throw new Error('Check or retry the saved remainder transaction before preparing another.')
  let cancelsSetup = false
  if (setup.signedTransaction) {
    const closedCancellation = [...(setup.refundHistory ?? []), ...(setup.refund ? [setup.refund] : [])]
      .find(item => item.cancelsSetup && item.confirmed && !item.superseded)
    if (closedCancellation) await canonicalTransaction(session, closedCancellation.hash, true)
    else if (await session.provider.getTransactionReceipt(setup.hash!)) await canonicalTransaction(session, setup.hash!, true)
    else {
      if (setup.used || setup.confirmed || setup.refund?.confirmed) throw new Error('The saved setup history changed. Preserve its recovery record.')
      cancelsSetup = true
    }
  }
  const [finalized, latest] = await Promise.all([session.provider.getBlock('finalized'), session.provider.getBlock('latest')])
  if (!finalized?.hash || !latest?.hash || latest.number < finalized.number) throw new Error('Canonical Base history is unavailable.')
  const [nonce, latestNonce, pendingNonce, code, latestCode, balance] = await Promise.all([
    session.provider.getTransactionCount(setup.account, finalized.number), session.provider.getTransactionCount(setup.account, latest.number),
    session.provider.getTransactionCount(setup.account, 'pending'), session.provider.getCode(setup.account, finalized.number),
    session.provider.getCode(setup.account, latest.number), session.provider.getBalance(setup.account, latest.number),
  ])
  if (nonce !== latestNonce || (cancelsSetup ? pendingNonce !== 0 && pendingNonce !== 1 : nonce !== pendingNonce) || code !== latestCode)
    throw new Error('Wait for the execution account transactions to finalize before returning its balance.')
  const delegated = `0xef0100${CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}`
  if (code !== '0x' && code.toLowerCase() !== delegated) throw new Error('The execution account delegation changed. Preserve its recovery record.')
  const executionNonce = code === '0x' ? 0n : BigInt(NONCE.decodeFunctionResult('nonce', await session.provider.call({ to: setup.account,
    data: NONCE.encodeFunctionData('nonce'), blockTag: finalized.number }))[0])
  if (cancelsSetup && (nonce !== 0 || code !== '0x')) throw new Error('The pending setup nonce changed. Check its saved outcome first.')
  const expectedNonce = setup.refund?.confirmed ? setup.refund.nonce + 1 : cancelsSetup ? 0 : setup.signedTransaction ? code === '0x' ? 1 : 2 : 0
  if (nonce < expectedNonce || (setup.used ? executionNonce === 0n : executionNonce !== 0n))
    throw new Error('A disclosed private execution must finish or be cancelled onchain before returning setup funds.')
  if ((await session.provider.getBlock(finalized.number))?.hash !== finalized.hash ||
    (await session.provider.getBlock(latest.number))?.hash !== latest.hash)
    throw new Error('Base recovery history changed. Check again before signing.')
  const recipientCode = await session.provider.getCode(setup.payer)
  if (recipientCode !== '0x' && !/^0xef0100[0-9a-f]{40}$/i.test(recipientCode))
    throw new Error('The recorded payer cannot receive this direct recovery transaction.')
  return { nonce, balance, cancelsSetup }
}
export async function prepareBaseSetupRefund(session: WalletSession, index?: number): Promise<BaseSetupRefund> {
  return exclusive(session, async () => {
    const setup = await savedBaseExecutionSetup(session, index)
    if (!setup || setup.version !== 2) throw new Error('No funded Base setup recovery exists for this index.')
    const { nonce, balance, cancelsSetup } = await refundState(session, setup)
    const fees = cancelsSetup ? await session.provider.getFeeData() : undefined
    const bumped = (saved: string, current: bigint | null | undefined) => {
      const minimum = (BigInt(saved) * 9n + 7n) / 8n
      return current && current > minimum ? current : minimum
    }
    const transaction = { from: setup.account, to: setup.payer, chainId: CHAIN, type: 2, nonce, data: '0x', value: 0n,
      ...(cancelsSetup ? { maxFeePerGas: bumped(setup.maxFeePerGas, fees?.maxFeePerGas),
        maxPriorityFeePerGas: bumped(setup.maxPriorityFeePerGas, fees?.maxPriorityFeePerGas) } : {}) }
    let feeQuote = await quoteBaseRefundFees(session.provider, transaction)
    for (let attempt = 0; attempt < 2; attempt++) {
      const available = balance - BigInt(feeQuote.maximumNetworkFee)
      if (available <= 0n) throw new Error(`The remaining ${balance} wei is below the estimated return fee. It stays in recovery account ${setup.index}.`)
      const value = available > 10_000_000_000_000n ? 10_000_000_000_000n : available
      const exact = await quoteBaseRefundFees(session.provider, { ...transaction, value })
      if (value + BigInt(exact.maximumNetworkFee) <= balance)
        return { index: setup.index, account: setup.account, payer: setup.payer, nonce, balance: balance.toString(), value: value.toString(), feeQuote: exact, ...(cancelsSetup ? { cancelsSetup: true } : {}) }
      feeQuote = exact
    }
    throw new Error('The return fee changed during review. No transaction was signed; review again.')
  })
}
export async function submitBaseSetupRefund(session: WalletSession, reviewed: BaseSetupRefund,
  beforeSend: () => void = () => {}): Promise<string> {
  return exclusive(session, async () => {
    const setup = await savedBaseExecutionSetup(session, reviewed.index)
    if (!setup || setup.version !== 2 || reviewed.account !== setup.account || reviewed.payer !== setup.payer ||
      !quantity(reviewed.balance) || !quantity(reviewed.value) || BigInt(reviewed.value) <= 0n || BigInt(reviewed.value) > 10_000_000_000_000n)
      throw new Error('The reviewed recovery does not match its saved execution account and payer.')
    await quoteCurrent(session, reviewed.feeQuote)
    const current = await refundState(session, setup)
    if (current.balance.toString() !== reviewed.balance || current.nonce !== reviewed.nonce || current.cancelsSetup !== !!reviewed.cancelsSetup ||
      BigInt(reviewed.value) + BigInt(reviewed.feeQuote.maximumNetworkFee) > current.balance)
      throw new Error('The remaining balance or nonce changed. Review the return again.')
    if (reviewed.cancelsSetup && (BigInt(reviewed.feeQuote.maxFeePerGas) * 8n < BigInt(setup.maxFeePerGas) * 9n ||
      BigInt(reviewed.feeQuote.maxPriorityFeePerGas) * 8n < BigInt(setup.maxPriorityFeePerGas) * 9n))
      throw new Error('The cancellation fee must replace both saved setup fee caps.')
    const transaction = refundTransaction(reviewed), fresh = await quoteBaseRefundFees(session.provider, transaction)
    if (unsignedTransaction(transaction).unsignedHash !== reviewed.feeQuote.unsignedHash ||
      fresh.unsignedHash !== reviewed.feeQuote.unsignedHash || BigInt(fresh.maximumNetworkFee) > BigInt(reviewed.feeQuote.maximumNetworkFee))
      throw new Error('The return fee increased. Review it again before signing.')
    beforeSend()
    // Retirement is permanent and precedes the signature; markUsed shares this lock.
    const retired: FundedBaseExecutionSetup = { ...setup, retired: true }
    await saveSetup(session, retired)
    const account = await session.accounts.getAccount(CHAIN, setup.index)
    const raw = await account.signer.signTransaction(transaction), tx = assertSigned(raw, transaction)
    const refund: SavedBaseSetupRefund = { ...reviewed, signedTransaction: raw, hash: tx.hash! }
    await saveSetup(session, { ...retired, refund,
      ...(setup.refund ? { refundHistory: [...(setup.refundHistory ?? []), setup.refund] } : {}) })
    beforeSend()
    const sent = await session.provider.broadcastTransaction(raw)
    if (sent.hash !== refund.hash) throw new Error('Return submission response did not match the saved signed transaction.')
    return refund.hash
  })
}
export async function checkBaseSetupRefund(session: WalletSession, index?: number): Promise<{ hash: string; confirmed: true; failed?: true; superseded?: true; remaining: string }> {
  return exclusive(session, async () => {
    await assertChain(session)
    const setup = await savedBaseExecutionSetup(session, index)
    if (!setup || setup.version !== 2 || !setup.refund) throw new Error('No saved Base remainder transaction exists for this index.')
    const refund = setup.refund
    if (!await session.provider.getTransactionReceipt(refund.hash) && refund.cancelsSetup && setup.hash) {
      await canonicalTransaction(session, setup.hash, true)
      assertSigned(setup.signedTransaction!, localSetupTransaction(setup), setup.hash)
      await saveSetup(session, { ...setup, refund: { ...refund, confirmed: true, failed: true, superseded: true } })
      return { hash: refund.hash, confirmed: true, failed: true, superseded: true, remaining: (await session.provider.getBalance(setup.account)).toString() }
    }
    const { receipt } = await canonicalTransaction(session, refund.hash, true)
    assertSigned(refund.signedTransaction, refundTransaction(refund), refund.hash)
    if (receipt.status !== 0 && receipt.status !== 1) throw new Error('The return receipt status is unavailable.')
    const failed = receipt.status === 0 ? true as const : undefined
    await saveSetup(session, { ...setup, refund: { ...refund, confirmed: true, ...(failed ? { failed } : {}) } })
    return { hash: refund.hash, confirmed: true, ...(failed ? { failed } : {}), remaining: (await session.provider.getBalance(setup.account)).toString() }
  })
}
export async function retryBaseSetupRefund(session: WalletSession, index?: number): Promise<string> {
  return exclusive(session, async () => {
    await assertChain(session)
    const setup = await savedBaseExecutionSetup(session, index)
    if (!setup || setup.version !== 2 || !setup.refund || setup.refund.confirmed) throw new Error('No pending signed remainder transaction exists.')
    const refund = setup.refund
    if (await session.provider.getTransactionReceipt(refund.hash)) throw new Error('This return has a receipt. Check its confirmation first.')
    const nonce = await session.provider.getTransactionCount(setup.account, 'latest')
    if (nonce !== refund.nonce) throw new Error('The recovery account nonce changed. Preserve the signed return and check its outcome.')
    assertSigned(refund.signedTransaction, refundTransaction(refund), refund.hash)
    const sent = await session.provider.broadcastTransaction(refund.signedTransaction)
    if (sent.hash !== refund.hash) throw new Error('Return retry response did not match its saved transaction.')
    return refund.hash
  })
}
