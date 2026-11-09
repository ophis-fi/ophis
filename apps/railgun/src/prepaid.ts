import { WakuBroadcasterClient } from '@railgun-community/waku-broadcaster-client-web'
import { balanceForERC20Token, encryptDataWithSharedKey, fullWalletForID, generateTransferProof,
  gasEstimateForUnprovenTransfer, getCompletedTxidFromNullifiers, getRailgunWalletAddressData,
  populateProvedTransfer, tryDecryptJSONDataWithSharedKey, validateRailgunAddress } from '@railgun-community/wallet'
import { calculateGasLimit, calculateGasPrice, calculateMaximumGas, EVMGasType, getEVMGasTypeForTransaction,
  type RailgunPopulateTransactionResponse, type SelectedBroadcaster, type TransactionGasDetails } from '@railgun-community/shared-models'
import { authorizationify, getAddress, hexlify, isHexString, keccak256, randomBytes, toUtf8Bytes, verifyAuthorization, ZeroAddress,
  type JsonRpcSigner, type TransactionRequest } from 'ethers'
import { Buffer } from 'buffer'
import { CREDIT_AUTHORIZATION_TYPES, CREDIT_PROTOCOL, CREDIT_REQUEST_LIFETIME, creditAuthorizationValue,
  creditDomain, creditMemo, creditRefundMemo, creditRequestKey, creditTopics, nativeCreditData, type CreditScope } from '../credit-protocol'
import { CHAIN, CHAIN_ID, CONFIG, NETWORK, PREPAID_BROADCASTERS, VERSION } from './config'
import { startBroadcasters } from './broadcaster'
import { assertFinalQuoteFresh, type FinalQuoteCheck } from './recipe'
import { readPrivateState, writePrivateState } from './storage'
import { assertPublicNetwork } from './shield'
import { pendingSwap } from './journal'
import { pendingWithdrawal } from './withdrawal-journal'
import { refreshReceivedBalances, requireWalletSync, type WalletSession } from './wallet'
import { prepaidAttemptFee } from './prepaid-pricing'
import { assertExecutionGuardCode, decodeGuardedExecution } from '../operator/execution-guard'
export { prepaidAttemptFee } from './prepaid-pricing'

interface CreditIdentity { scope: CreditScope; ledgerId: string; owner: string; executionEnabled?: boolean }
export interface PreparedCredit extends CreditIdentity {
  feesID: string; expires: number; rate: bigint; collectionAllowance: bigint; nextSequence: number
  maximumGasCost: bigint; maximumGasPrice: bigint; maximumCharge: bigint; selected: SelectedBroadcaster
  maximumRefundGross?: bigint
  refundGasAllowance?: bigint
}
export interface CreditBalance { owner: string; available: bigint; deposited: bigint; charged: bigint; reserved: bigint; refunds: bigint; funding?: 'native' }
interface SavedAttempt { payload: string; key: string; hash?: string; state?: string; rate?: string; nonce?: number }
interface SavedTopUp {
  transaction: { to: string; data: string; value: string }; nullifiers: string[]; from: string; hash?: string; nonce?: number
  previous?: { hash?: string; nonce: number }[]
  paymentId?: string
}
interface SavedRefund { payload: string; key: string; hash?: string; rate?: string; nonce?: number }
interface CreditJournal extends CreditIdentity {
  attempt?: SavedAttempt; topUp?: SavedTopUp; refund?: SavedRefund
  completed?: { attempt: SavedAttempt; cancellationHash?: string; charged: string; cancelled: boolean; state?: 'not-reserved' }
}
const journalKey = () => PREPAID_BROADCASTERS[CHAIN_ID]?.funding === 'native' ? 'nativePrepaidCredit' : 'prepaidCredit'
const subscribers = new Map<string, (message: unknown) => void>()
let subscribedCore: ReturnType<typeof WakuBroadcasterClient.getWakuCore>
let subscribing: Promise<void> | undefined
const busy = new WeakSet<WalletSession>()
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (value: unknown): string => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)
const quantity = (value: unknown, positive = false): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('Invalid prepaid quantity.')
  const number = BigInt(value)
  if (number >= 2n ** 256n || (positive && !number)) throw new Error('Invalid prepaid quantity.')
  return number
}
function requestSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid prepaid request sequence. Keep saved requests for recovery.')
  return value
}
function pinNativeNonce(response: Record<string, unknown>, pending: { nonce?: number }): void {
  const nonce = response.nonce
  if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0 ||
    (pending.nonce !== undefined && pending.nonce !== nonce)) throw new Error('The saved native operator nonce changed. Keep its recovery record.')
  pending.nonce = nonce
}

async function exclusive<T>(session: WalletSession, action: () => Promise<T>): Promise<T> {
  if (busy.has(session)) throw new Error('A prepaid operation is already running.')
  busy.add(session)
  try { return await action() } finally { busy.delete(session) }
}
function policy(fresh = true) {
  const approved = PREPAID_BROADCASTERS[CHAIN_ID]
  if (![1, 56].includes(CHAIN_ID) || !approved || (fresh && approved.expiresAt <= Date.now() + 15 * 60_000))
    throw new Error('Prepaid execution is not approved on this network.')
  return approved
}
function validateIdentity(identity: CreditIdentity, fresh = false): void {
  const approved = policy(fresh), scope = identity.scope
  creditDomain(scope, identity.ledgerId)
  if (scope.chainId !== CHAIN_ID || getAddress(scope.operator) !== getAddress(approved.operator) ||
    (scope.funding === 'native'
      ? getAddress(scope.recipient) !== getAddress(approved.operator) || getAddress(scope.token) !== ZeroAddress
      : scope.recipient !== approved.railgunAddress || getAddress(scope.token) !== getAddress(CONFIG.baseToken.wrappedAddress)) ||
    (fresh && scope.funding !== approved.funding))
    throw new Error('Prepaid broadcaster scope changed. Keep the saved credit records.')
  getAddress(identity.owner)
}
async function saved(session: WalletSession): Promise<CreditJournal | undefined> {
  const value = await readPrivateState(session, journalKey())
  if (value === undefined) return
  if (!object(value) || !object(value.scope) || typeof value.ledgerId !== 'string' || typeof value.owner !== 'string')
    throw new Error('Prepaid recovery data is damaged. Keep it for recovery.')
  const record = value as unknown as CreditJournal
  validateIdentity(record)
  if (record.attempt && (!object(record.attempt) || typeof record.attempt.payload !== 'string' ||
    record.attempt.key !== creditRequestKey(record.ledgerId, record.owner, record.attempt.payload)))
    throw new Error('The saved prepaid attempt is damaged.')
  if (record.refund && (!object(record.refund) || typeof record.refund.payload !== 'string' ||
    (record.refund.hash !== undefined && !isHexString(record.refund.hash, 32)) ||
    record.refund.key !== creditRequestKey(record.ledgerId, record.owner, record.refund.payload)))
    throw new Error('The saved prepaid refund is damaged.')
  if (record.scope.funding === 'native') {
    for (const pending of [record.attempt, record.refund]) if (pending) {
      if (quantity(pending.rate, true) < 10n ** 18n) throw new Error('The saved native payment rate is invalid. Preserve the record.')
      if (pending.nonce !== undefined) pinNativeNonce({ nonce: pending.nonce }, pending)
    }
  }
  if (record.completed && (!object(record.completed) || !object(record.completed.attempt) ||
    record.completed.attempt.key !== creditRequestKey(record.ledgerId, record.owner, record.completed.attempt.payload) ||
    typeof record.completed.charged !== 'string' || typeof record.completed.cancelled !== 'boolean' ||
    (record.completed.state !== undefined && (record.completed.state !== 'not-reserved' ||
      record.completed.attempt.hash !== undefined || record.completed.cancellationHash !== undefined ||
      record.completed.charged !== '0' || record.completed.cancelled))))
    throw new Error('The saved prepaid settlement is damaged.')
  if (record.topUp) {
    const topUp = record.topUp
    if (!object(topUp) || !object(topUp.transaction) || typeof topUp.transaction.data !== 'string' ||
      !isHexString(topUp.transaction.data) || !Array.isArray(topUp.nullifiers)) throw new Error('The saved prepaid top-up is damaged.')
    if (record.scope.funding === 'native') {
      if (topUp.transaction.to !== getAddress(record.scope.operator) || quantity(topUp.transaction.value, true) >= 2n ** 120n ||
        typeof topUp.paymentId !== 'string' || topUp.transaction.data !== nativeCreditData(record.scope, record.ledgerId, record.owner, topUp.paymentId) ||
        topUp.nullifiers.length || getAddress(topUp.from) === getAddress(record.scope.operator))
        throw new Error('The saved native payment is damaged. Preserve it for recovery.')
    } else if (topUp.transaction.to !== getAddress(CONFIG.proxyContract) || topUp.transaction.value !== '0' ||
      topUp.paymentId !== undefined || !topUp.nullifiers.length || !topUp.nullifiers.every((n) => isHexString(n, 32)))
      throw new Error('The saved prepaid top-up is damaged.')
  }
  return record
}

async function exchange(data: Record<string, unknown>, recipient: string, expectedKey?: string,
  beforeSend?: () => void): Promise<Record<string, unknown>> {
  await startBroadcasters(() => {})
  const core = WakuBroadcasterClient.getWakuCore()
  if (!core) throw new Error('The private broadcaster transport is unavailable.')
  if (subscribedCore !== core) {
    subscribing ??= WakuBroadcasterClient.addTransportSubscription(core, creditTopics(CHAIN_ID).response,
      (message: unknown) => { for (const callback of subscribers.values()) callback(message) })
      .then(() => { subscribedCore = core }).finally(() => { subscribing = undefined })
    await subscribing
  }
  const correlation = hexlify(randomBytes(32))
  const viewingKey = getRailgunWalletAddressData(recipient).viewingPublicKey
  const encrypted = await encryptDataWithSharedKey({ ...data, protocol: CREDIT_PROTOCOL, correlation,
    broadcasterViewingKey: Buffer.from(viewingKey).toString('hex') }, viewingKey)
  const packet = { method: 'transact', id: correlation, params: { pubkey: encrypted.randomPubKey, encryptedData: encrypted.encryptedData } }
  const key = expectedKey ?? keccak256(toUtf8Bytes(JSON.stringify([encrypted.randomPubKey.toLowerCase(), encrypted.encryptedData])))
  beforeSend?.()
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => { subscribers.delete(correlation); reject(new Error('Prepaid response timed out. Keep the saved attempt for recovery.')) }, 45_000)
    subscribers.set(correlation, (message) => {
      try {
        if (!object(message) || !(message.payload instanceof Uint8Array)) return
        const envelope: unknown = JSON.parse(new TextDecoder().decode(message.payload))
        if (!object(envelope) || envelope.id !== correlation) return
        const response: unknown = tryDecryptJSONDataWithSharedKey(envelope.result as [string, string], encrypted.sharedKey)
        if (!object(response) || response.protocol !== CREDIT_PROTOCOL || response.correlation !== correlation || response.key !== key) return
        clearTimeout(timeout); subscribers.delete(correlation)
        if (typeof response.error === 'string') reject(new Error(response.error.slice(0, 500)))
        else resolve(response)
      } catch { /* Other clients' encrypted responses are not ours. */ }
    })
    void WakuBroadcasterClient.sendTransport(packet, creditTopics(CHAIN_ID).request).catch((error: unknown) => {
      clearTimeout(timeout); subscribers.delete(correlation); reject(error)
    })
  })
}

async function authorize(session: WalletSession, identity: CreditIdentity, payload: string, beforeSend?: () => void) {
  validateIdentity(identity)
  const signer = (await session.accounts.getAccount(CHAIN, 0)).signer
  if (getAddress(signer.address) !== getAddress(identity.owner)) throw new Error('Prepaid claimant changed.')
  const expires = Date.now() + CREDIT_REQUEST_LIFETIME
  const signature = await signer.signTypedData(creditDomain(identity.scope, identity.ledgerId), CREDIT_AUTHORIZATION_TYPES,
    creditAuthorizationValue(identity.scope, identity.owner, payload, expires))
  return exchange({ authorization: { owner: identity.owner, payload, expires, signature } }, policy(false).railgunAddress,
    creditRequestKey(identity.ledgerId, identity.owner, payload), beforeSend)
}
async function identity(session: WalletSession): Promise<CreditIdentity> {
  const approved = policy(false)
  const previous = await saved(session)
  const response = await exchange({ kind: 'info' }, approved.railgunAddress)
  if (!object(response.scope) || typeof response.ledgerId !== 'string' || response.confirmation !== 'finalized' ||
    response.scope.funding !== (previous ? previous.scope.funding : approved.funding) || response.funding !== (response.scope.funding === 'native'
      ? 'user-submitted-native-transfer' : 'user-submitted-private-transfer')) throw new Error('Invalid prepaid service identity.')
  const result: CreditIdentity = { scope: response.scope as unknown as CreditScope, ledgerId: response.ledgerId,
    owner: (await session.accounts.getAccount(CHAIN, 0)).signer.address, executionEnabled: response.executionEnabled === true }
  validateIdentity(result)
  if (previous && (previous.ledgerId !== result.ledgerId || previous.scope.funding !== result.scope.funding || getAddress(previous.owner) !== getAddress(result.owner)))
    throw new Error('The prepaid ledger or claimant changed. Keep the previous credit records for recovery.')
  if (!previous) await writePrivateState(session, journalKey(), result)
  return result
}
function balance(response: Record<string, unknown>, expected: CreditIdentity): CreditBalance {
  if (response.kind !== 'balance' || response.owner !== expected.owner ||
    (expected.scope.funding !== 'native' && response.memo !== creditMemo(expected.scope, expected.ledgerId, expected.owner))) throw new Error('Invalid prepaid balance response.')
  const result = { owner: expected.owner, funding: expected.scope.funding, available: quantity(response.available), deposited: quantity(response.deposited),
    charged: quantity(response.charged), reserved: quantity(response.reserved), refunds: quantity(response.refunds) }
  if (result.available + result.charged + result.reserved + result.refunds !== result.deposited)
    throw new Error('The prepaid balance is inconsistent.')
  return result
}
export async function prepaidBalance(session: WalletSession): Promise<CreditBalance> {
  const current = await identity(session)
  return balance(await authorize(session, current, json({ kind: 'balance' })), current)
}
async function prepareQuote(session: WalletSession, onStatus: (message: string) => void, admission: boolean): Promise<PreparedCredit> {
  onStatus('Checking the prepaid broadcaster and gas limits…')
  policy(admission)
  const current = await identity(session)
  if (admission) validateIdentity(current, true)
  if (admission && !current.executionEnabled) throw new Error('Prepaid execution is paused. Existing credit recovery remains available.')
  const response = await authorize(session, current, json({ kind: 'quote', ...(!admission && { refund: true }) }))
  if (response.kind !== 'quote' || typeof response.feesID !== 'string' || !/^[0-9a-f]{64}$/.test(response.feesID) ||
    typeof response.expires !== 'number' || !Number.isSafeInteger(response.expires) || response.expires <= Date.now() + 60_000 ||
    response.expires > Date.now() + CREDIT_REQUEST_LIFETIME) throw new Error('Invalid prepaid quote.')
  const rate = quantity(response.rate, true), collectionAllowance = quantity(response.collectionAllowance, current.scope.funding !== 'native')
  const refundGasAllowance = current.scope.funding === 'native' ? quantity(response.refundGasAllowance, true) : undefined
  const maximumGasCost = quantity(response.maximumGasCost, true), maximumGasPrice = quantity(response.maximumGasPrice, true)
  const maximumCharge = quantity(response.maximumCharge, true), approved = policy(admission)
  if (rate < 10n ** 18n || maximumGasCost > approved.maxTransactionCost || maximumGasPrice > approved.maxGasPrice ||
    maximumCharge !== ((maximumGasCost + collectionAllowance) * rate + 10n ** 18n - 1n) / 10n ** 18n ||
    (current.scope.funding === 'native' && (collectionAllowance !== 0n || refundGasAllowance! > maximumGasCost)))
    throw new Error('The prepaid quote exceeds the reviewed limits.')
  return { ...current, feesID: response.feesID, expires: response.expires, rate, collectionAllowance, nextSequence: requestSequence(response.nextSequence),
    maximumGasCost, maximumGasPrice, maximumCharge, ...(refundGasAllowance === undefined ? {} : { refundGasAllowance }),
    ...(!admission && { maximumRefundGross: quantity(response.maximumRefundGross) }),
    selected: { railgunAddress: policy(false).railgunAddress, tokenAddress: current.scope.funding === 'native' ? CONFIG.baseToken.wrappedAddress : current.scope.token,
      tokenFee: { feesID: response.feesID, expiration: response.expires, feePerUnitGas: rate.toString(), availableWallets: 1,
        relayAdapt: CONFIG.relayAdaptContract, relayAdapt7702: CONFIG.relayAdapt7702Contract, reliability: 1 } } }
}
export function preparePrepaid(session: WalletSession, onStatus: (message: string) => void = () => {}): Promise<PreparedCredit> {
  return prepareQuote(session, onStatus, true)
}
export async function preparePrepaidRefund(session: WalletSession, onStatus: (message: string) => void = () => {}): Promise<PreparedCredit> {
  if (!await saved(session)) throw new Error('Load the balance of the pinned prepaid ledger before requesting a refund.')
  return prepareQuote(session, onStatus, false)
}
export async function assertPrepaidContext(session: WalletSession, selected: SelectedBroadcaster,
  gas: TransactionGasDetails, credit: PreparedCredit): Promise<void> {
  validateIdentity(credit, true)
  if (!credit.executionEnabled || (await session.provider.getNetwork()).chainId !== CHAIN ||
    getAddress((await session.accounts.getAccount(CHAIN, 0)).signer.address) !== getAddress(credit.owner) ||
    selected.railgunAddress !== policy(false).railgunAddress || getAddress(selected.tokenAddress) !==
      getAddress(credit.scope.funding === 'native' ? CONFIG.baseToken.wrappedAddress : credit.scope.token) ||
    selected.tokenFee.feesID !== credit.feesID || selected.tokenFee.expiration !== credit.expires ||
    BigInt(selected.tokenFee.feePerUnitGas) !== credit.rate || credit.expires <= Date.now() + 60_000 ||
    gas.gasEstimate <= 0n || calculateGasPrice(gas) <= 0n || calculateMaximumGas(gas) > credit.maximumGasCost ||
    calculateGasPrice(gas) > credit.maximumGasPrice || prepaidAttemptFee(credit, gas) > credit.maximumCharge)
    throw new Error('The prepaid quote, claimant or gas limits changed. Prepare another quote before proving.')
  const previous = await saved(session)
  if (!previous || previous.ledgerId !== credit.ledgerId || previous.owner !== credit.owner)
    throw new Error('The prepaid quote differs from the saved credit identity.')
  if (previous.attempt || previous.topUp || previous.refund) throw new Error('Reconcile the saved prepaid operation before preparing another proof.')
  const available = balance(await authorize(session, credit, json({ kind: 'balance' })), credit).available
  if (available < prepaidAttemptFee(credit, gas))
    throw new Error('Confirmed prepaid credit is insufficient. Add credit before preparing a private proof.')
}

export async function submitPrepaid(session: WalletSession, populated: RailgunPopulateTransactionResponse,
  selected: SelectedBroadcaster, gas: TransactionGasDetails, use7702: boolean,
  checkedAt: FinalQuoteCheck | undefined, credit: PreparedCredit): Promise<string> {
  return exclusive(session, async () => {
    await assertPrepaidContext(session, selected, gas, credit)
    const previous = await saved(session)
    if (previous?.attempt || previous?.topUp || previous?.refund) throw new Error('Reconcile the saved prepaid operation before submitting another.')
    if (use7702) assertFinalQuoteFresh(checkedAt)
    const tx = populated.transaction as TransactionRequest
    if (!populated.nullifiers?.length || typeof tx.to !== 'string' || typeof tx.data !== 'string' || BigInt(tx.value ?? 0) !== 0n ||
      (use7702 ? gas.evmGasType !== EVMGasType.Type4 || tx.authorizationList?.length !== 1
        : gas.evmGasType !== getEVMGasTypeForTransaction(NETWORK, false) || getAddress(tx.to) !== getAddress(CONFIG.proxyContract) || !!tx.authorizationList?.length))
      throw new Error('Invalid prepaid private execution.')
    const authorization = use7702 ? authorizationify(tx.authorizationList![0]) : undefined
    if (authorization && (authorization.chainId !== CHAIN || getAddress(authorization.address) !== getAddress(CONFIG.relayAdapt7702Contract) ||
      getAddress(verifyAuthorization(authorization, authorization.signature)) !== getAddress(tx.to)))
      throw new Error('The prepaid authorization does not match the selected account or delegate.')
    const request = { txidVersion: VERSION, chainType: 0, chainID: CHAIN_ID, to: tx.to, data: tx.data,
      feesID: credit.feesID, useRelayAdapt: use7702, minVersion: '8.0.0', maxVersion: '8.999.0',
      transactType: use7702 ? 'TX7702' : 'COMMON', preTransactionPOIsPerTxidLeafPerList: populated.preTransactionPOIsPerTxidLeafPerList ?? {},
      ...(gas.evmGasType === EVMGasType.Type4 ? { authorization,
        gasLimit: calculateGasLimit(gas.gasEstimate).toString(), maxFeePerGas: gas.maxFeePerGas.toString(),
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas.toString() } : { minGasPrice: calculateGasPrice(gas).toString() }) }
    const payload = json({ kind: 'execute', request, sequence: requestSequence(credit.nextSequence), maximumCharge: prepaidAttemptFee(credit, gas).toString(),
      collectionAllowance: credit.collectionAllowance.toString() })
    creditAuthorizationValue(credit.scope, credit.owner, payload, Date.now() + CREDIT_REQUEST_LIFETIME)
    const record: CreditJournal = { ...previous, scope: credit.scope, ledgerId: credit.ledgerId, owner: credit.owner,
      attempt: { payload, key: creditRequestKey(credit.ledgerId, credit.owner, payload),
        ...(credit.scope.funding === 'native' && { rate: credit.rate.toString() }) } }
    await writePrivateState(session, journalKey(), record)
    if (use7702) assertFinalQuoteFresh(checkedAt)
    return sendSaved(session, record, () => {
      validateIdentity(credit, true)
      if (credit.expires <= Date.now() + 60_000) throw new Error('The prepaid quote expired before submission.')
      if (use7702) assertFinalQuoteFresh(checkedAt)
    })
  })
}
async function sendSaved(session: WalletSession, record: CreditJournal, beforeSend?: () => void): Promise<string> {
  const attempt = record.attempt!
  const response = await authorize(session, record, attempt.payload, beforeSend)
  const hash = response.txHash ?? response.hash
  if (typeof hash !== 'string' || !isHexString(hash, 32)) throw new Error('Prepaid execution is reserved or unknown. Keep the saved attempt for recovery.')
  if (attempt.hash && attempt.hash !== hash) throw new Error('The prepaid operation hash changed. Keep the saved attempt.')
  if (record.scope.funding === 'native') pinNativeNonce(response, attempt)
  attempt.hash = hash; attempt.state = typeof response.state === 'string' ? response.state : 'submitted-or-unknown'
  await writePrivateState(session, journalKey(), record)
  return hash
}
export async function retryPrepaid(session: WalletSession): Promise<string> {
  return exclusive(session, async () => {
    const record = await saved(session)
    if (!record?.attempt) throw new Error('No prepaid attempt is saved.')
    return sendSaved(session, record)
  })
}
export async function pendingPrepaid(session: WalletSession) {
  const record = await saved(session)
  const attempt = record?.attempt ?? record?.completed?.attempt
  const request: unknown = attempt && JSON.parse(attempt.payload).request
  return record && { key: attempt?.key, hash: attempt?.hash, state: attempt?.state, completed: !record.attempt && !!record.completed,
    request: object(request) && typeof request.to === 'string' && typeof request.data === 'string'
      ? { to: request.to, data: request.data } : undefined,
    topUpPending: !!record.topUp, topUpHash: record.topUp?.hash, refundPending: !!record.refund, funding: record.scope.funding }
}

export async function checkPrepaid(session: WalletSession) {
  return exclusive(session, async () => {
    const record = await saved(session)
    if (!record?.attempt) {
      if (record?.completed) return { key: record.completed.attempt.key, hash: record.completed.attempt.hash,
        cancellationHash: record.completed.cancellationHash, state: record.completed.state ?? 'settled', charged: quantity(record.completed.charged),
        cancelled: record.completed.cancelled }
      throw new Error('No prepaid attempt is saved.')
    }
    const response = await authorize(session, record, recoveryPayload(record.attempt, 'execute'))
    if (unreserved(response, record.attempt, 'execute')) {
      if (record.attempt.hash) throw new Error('The broadcaster lost an acknowledged attempt. Keep its recovery records.')
      // Retirement closes only the fee request; the private proof may already have reached an RPC.
      record.completed = { attempt: { ...record.attempt, state: 'not-reserved' }, state: 'not-reserved', charged: '0', cancelled: false }
      delete record.attempt
      await writePrivateState(session, journalKey(), record)
      return { key: record.completed.attempt.key, hash: undefined, cancellationHash: undefined,
        state: 'not-reserved', charged: 0n, cancelled: false }
    }
    if (response.kind !== 'attempt' || !['reserved-before-signing', 'submitted-or-unknown', 'settled'].includes(String(response.state)))
      throw new Error('Invalid prepaid attempt status.')
    const hash = typeof response.hash === 'string' && isHexString(response.hash, 32) ? response.hash : undefined
    const cancellationHash: string | undefined = typeof response.cancellationHash === 'string' && isHexString(response.cancellationHash, 32)
      ? response.cancellationHash : undefined
    const settlementHash = typeof response.settlementHash === 'string' && isHexString(response.settlementHash, 32)
      ? response.settlementHash : undefined
    if (record.attempt.hash && hash !== record.attempt.hash) throw new Error('The prepaid operation hash changed.')
    if (record.scope.funding === 'native') pinNativeNonce(response, record.attempt)
    record.attempt.hash = hash; record.attempt.state = String(response.state)
    const result = { key: record.attempt.key, hash, cancellationHash, state: String(response.state),
      charged: response.charged === null ? undefined : quantity(response.charged), cancelled: false }
    if (response.state === 'settled') {
      const cap = quantity(JSON.parse(record.attempt.payload).maximumCharge, true)
      if (result.charged === undefined || result.charged > cap) throw new Error('Prepaid settlement exceeds the signed cap.')
      const receipts = await Promise.all([settlementHash, hash, cancellationHash].map((candidate) => candidate
        ? session.provider.getTransactionReceipt(candidate) : null))
      const receipt = receipts.find((candidate) => candidate !== null)
      if (!receipt) throw new Error('The prepaid settlement is not confirmed. Keep the saved attempt.')
      const [finalized, block, transaction] = await Promise.all([session.provider.getBlock('finalized'),
        session.provider.getBlock(receipt.blockNumber), session.provider.getTransaction(receipt.hash)])
      if (!finalized || receipt.blockNumber > finalized.number || block?.hash !== receipt.blockHash ||
        !transaction || getAddress(transaction.from) !== getAddress(record.scope.operator) || transaction.chainId !== CHAIN)
        throw new Error('The prepaid settlement is not finalized. Keep the saved attempt.')
      result.cancelled = receipt.hash !== hash
      if (record.scope.funding === 'native') {
        if (transaction.nonce !== record.attempt.nonce) throw new Error('The settlement differs from the saved operator nonce.')
        const expectedCharge = (receipt.gasUsed * receipt.gasPrice * quantity(record.attempt.rate, true) + 10n ** 18n - 1n) / 10n ** 18n
        if (result.charged !== expectedCharge) throw new Error('The settled charge differs from actual gas and the reviewed margin.')
        const request = JSON.parse(record.attempt.payload).request
        if (result.cancelled) {
          if (receipt.status !== 1 || transaction.value !== 0n ||
            transaction.data !== '0x' || getAddress(transaction.to ?? '') !== getAddress(record.scope.operator))
            throw new Error('The cancellation does not match the saved operator nonce.')
        } else if (transaction.value !== 0n) throw new Error('The private execution has unexpected public value.')
        else if (getAddress(transaction.to ?? '') !== getAddress(request.to) || transaction.data.toLowerCase() !== String(request.data).toLowerCase()) {
          if (!request.useRelayAdapt) throw new Error('The settled transaction differs from the saved request.')
          const guarded = decodeGuardedExecution(transaction.data)
          if (guarded.account !== getAddress(request.to) || guarded.execution.toLowerCase() !== String(request.data).toLowerCase())
            throw new Error('The guarded transaction differs from the saved request.')
          const [code, delegate] = await Promise.all([session.provider.getCode(transaction.to!, receipt.blockNumber),
            session.provider.getCode(CONFIG.relayAdapt7702Contract, receipt.blockNumber)])
          assertExecutionGuardCode(record.scope.operator, code, delegate, CONFIG.relayAdapt7702Contract)
        }
      }
      if (result.cancelled) result.cancellationHash = receipt.hash
      record.completed = { attempt: { ...record.attempt, state: 'settled' }, cancellationHash: result.cancellationHash,
        charged: result.charged.toString(), cancelled: result.cancelled }
      delete record.attempt
    }
    await writePrivateState(session, journalKey(), record)
    return result
  })
}

export async function topUpPrepaid(session: WalletSession, signer: JsonRpcSigner, amount: bigint,
  onProgress: (message: string) => void, credit: PreparedCredit): Promise<string> {
  return exclusive(session, async () => {
    requireWalletSync(); validateIdentity(credit, true)
    const current = await identity(session)
    if (!current.executionEnabled || current.ledgerId !== credit.ledgerId || current.owner !== credit.owner || credit.expires <= Date.now() + 60_000)
      throw new Error('Refresh the prepaid quote before adding credit.')
    const previous = await saved(session)
    if (previous?.attempt || previous?.topUp || previous?.refund || await pendingSwap(session) || await pendingWithdrawal(session))
      throw new Error('Reconcile the pending private operation before adding prepaid credit.')
    if (amount <= 0n || amount >= 2n ** 120n) throw new Error('Invalid private top-up amount.')
    await assertPublicNetwork(session, signer)
    const from = getAddress(await signer.getAddress())
    if (from === getAddress(credit.owner)) throw new Error('Use your connected public wallet for gas, not the derived credit claimant.')
    if (credit.scope.funding === 'native') {
      if (from === getAddress(credit.scope.operator)) throw new Error('The broadcaster gas wallet cannot fund customer credit.')
      // shortcut: standard EOA transfers only; qualify smart-account internal transfers before accepting their funds.
      const [senderCode, recipientCode] = await Promise.all([signer.provider.getCode(from), session.provider.getCode(credit.scope.operator)])
      if (senderCode !== '0x' || recipientCode !== '0x')
        throw new Error('Native fee credit currently requires a standard public account without smart-account delegation. No payment was requested.')
      const paymentId = hexlify(randomBytes(32))
      const nonce = await signer.provider.getTransactionCount(from, 'pending')
      if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Public payment nonce is unavailable.')
      const transaction = { to: getAddress(credit.scope.operator), data: nativeCreditData(credit.scope, credit.ledgerId, credit.owner, paymentId), value: amount.toString() }
      const record: CreditJournal = { ...previous, scope: credit.scope, ledgerId: credit.ledgerId, owner: credit.owner,
        topUp: { transaction, paymentId, nullifiers: [], from, nonce } }
      await writePrivateState(session, journalKey(), record)
      validateIdentity(credit, true)
      await assertPublicNetwork(session, signer)
      if (getAddress(await signer.getAddress()) !== from) throw new Error('The public payment wallet changed. Keep the saved payment.')
      onProgress('Confirm the public native fee payment. Its sender, recipient and amount are public; your wallet also pays its gas.')
      const sent = await signer.sendTransaction({ ...transaction, value: amount, nonce, chainId: CHAIN, type: 2 })
      record.topUp!.hash = sent.hash
      await writePrivateState(session, journalKey(), record)
      onProgress(`Native top-up submitted: ${sent.hash}. Credit requires finalized payment; do not send another payment.`)
      return sent.hash
    }
    await refreshReceivedBalances(session)
    if (await balanceForERC20Token(VERSION, fullWalletForID(session.info.id), NETWORK, credit.scope.token, true) < amount)
      throw new Error('Insufficient spendable wrapped native token for the private top-up.')
    const memo = creditMemo(credit.scope, credit.ledgerId, credit.owner)
    const recipients = [{ tokenAddress: credit.scope.token, amount, recipientAddress: credit.scope.recipient }]
    const fees = await signer.provider.getFeeData(), type = getEVMGasTypeForTransaction(NETWORK, true)
    const gas: TransactionGasDetails = type === EVMGasType.Type0
      ? { evmGasType: EVMGasType.Type0, gasEstimate: 3_000_000n, gasPrice: fees.gasPrice ?? 0n }
      : { evmGasType: EVMGasType.Type2, gasEstimate: 3_000_000n,
        maxFeePerGas: fees.maxFeePerGas ?? 0n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n }
    if (calculateGasPrice(gas) <= 0n) throw new Error('Public-wallet gas pricing is unavailable.')
    const estimate = await gasEstimateForUnprovenTransfer(VERSION, NETWORK, session.info.id, session.key, memo, recipients, [], gas, undefined, true)
    await generateTransferProof(VERSION, NETWORK, session.info.id, session.key, false, memo, recipients, [], undefined, true, 0n,
      (progress, status) => onProgress(`${status}: ${Math.round(progress)}%`))
    const populated = await populateProvedTransfer(VERSION, NETWORK, session.info.id, false, memo, recipients, [], undefined, true, 0n,
      { ...gas, gasEstimate: estimate.gasEstimate })
    const tx = populated.transaction
    if (typeof tx.to !== 'string' || getAddress(tx.to) !== getAddress(CONFIG.proxyContract) || typeof tx.data !== 'string' ||
      BigInt(tx.value ?? 0) !== 0n || (tx.chainId != null && BigInt(tx.chainId) !== CHAIN) || tx.authorizationList?.length || !populated.nullifiers?.length)
      throw new Error('Invalid proved private top-up.')
    const nonce = await signer.provider.getTransactionCount(from, 'pending')
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('The public gas wallet nonce is unavailable.')
    const record: CreditJournal = { ...previous, scope: credit.scope, ledgerId: credit.ledgerId, owner: credit.owner,
      topUp: { transaction: { to: getAddress(tx.to), data: tx.data, value: '0' }, from,
        nonce, nullifiers: populated.nullifiers.map((n) => `0x${n.replace(/^0x/, '').padStart(64, '0')}`) } }
    await writePrivateState(session, journalKey(), record)
    if (!(await identity(session)).executionEnabled) throw new Error('Prepaid execution paused. Keep the saved top-up proof for recovery.')
    validateIdentity(credit, true)
    await assertPublicNetwork(session, signer)
    if (getAddress(await signer.getAddress()) !== from) throw new Error('The public gas wallet changed. Keep the saved top-up proof.')
    onProgress('Confirm the private top-up in your connected wallet. It pays public gas.')
    const sent = await signer.sendTransaction({ ...tx, nonce, chainId: CHAIN })
    record.topUp!.hash = sent.hash
    await writePrivateState(session, journalKey(), record)
    onProgress(`Top-up submitted: ${sent.hash}. Credit becomes available after finality; use Check top-up.`)
    return sent.hash
  })
}

export function prepaidRefundFee(credit: PreparedCredit): bigint {
  const gas = credit.scope.funding === 'native' ? credit.refundGasAllowance : credit.collectionAllowance
  if (gas === undefined || gas < 0n) throw new Error('The refund gas allowance is missing.')
  return (gas * credit.rate + 10n ** 18n - 1n) / 10n ** 18n
}
function recoveryPayload(request: SavedRefund, operation: 'execute' | 'refund'): string {
  const sequence = JSON.parse(request.payload).sequence
  return json({ kind: 'recover', operation, payloadHash: keccak256(toUtf8Bytes(request.payload)),
    sequence: sequence === undefined ? undefined : requestSequence(sequence) })
}
function unreserved(response: Record<string, unknown>, request: SavedRefund, operation: 'execute' | 'refund'): boolean {
  if (response.kind !== 'recovery') return false
  const originalSequence = JSON.parse(request.payload).sequence
  const sequence = originalSequence === undefined ? null : requestSequence(originalSequence)
  if (response.recoveredKey !== request.key || response.operation !== operation || response.state !== 'not-reserved' ||
    response.sequence !== sequence || typeof response.retiredThrough !== 'number' || !Number.isSafeInteger(response.retiredThrough) ||
    response.retiredThrough < 0 || response.retiredThrough >= Number.MAX_SAFE_INTEGER ||
    (sequence !== null && response.retiredThrough < sequence))
    throw new Error('Invalid prepaid recovery response. Keep the saved request.')
  return true
}
function refundResult(response: Record<string, unknown>, record: CreditJournal) {
  const pending = record.refund!, payload = JSON.parse(pending.payload)
  const native = record.scope.funding === 'native'
  if (response.kind !== 'refund' || response.recipient !== payload.recipient || response.gross !== payload.gross || response.net !== payload.net)
    throw new Error('Invalid prepaid refund status.')
  if (native) {
    pinNativeNonce(response, pending)
    const terminal = response.state === 'refunded' || response.state === 'failed'
    if (!['reserved-before-signing', 'submitted-or-unknown', 'refunded', 'failed'].includes(String(response.state)) ||
      [response.transactionHash, response.cancellationHash, response.settlementHash].some((hash) => hash !== null && hash !== undefined && (typeof hash !== 'string' || !isHexString(hash, 32))) ||
      (terminal && (!isHexString(response.settlementHash, 32) || !isHexString(response.transactionHash, 32))) ||
      (!terminal && (response.charged !== null || response.netPaid !== null))) throw new Error('Invalid prepaid refund settlement.')
    if (pending.hash && pending.hash !== response.transactionHash) throw new Error('The saved native refund hash changed. Keep its recovery record.')
    if (typeof response.transactionHash === 'string') pending.hash = response.transactionHash
    if (terminal) {
      const charged = quantity(response.charged), paid = quantity(response.netPaid)
      if (charged > quantity(payload.gross) || charged < paid || paid !== (response.state === 'refunded' ? quantity(payload.net) : 0n))
        throw new Error('Invalid prepaid refund accounting.')
    }
  } else if (
    response.memo !== creditRefundMemo(record.scope, record.ledgerId, pending.key) ||
    !['awaiting-owner-transfer', 'refunded'].includes(String(response.state)) ||
    (response.state === 'refunded' && (typeof response.transactionHash !== 'string' || !isHexString(response.transactionHash, 32))))
    throw new Error('Invalid prepaid refund status.')
  return { key: pending.key, funding: record.scope.funding, recipient: String(response.recipient), gross: quantity(response.gross, true), net: quantity(response.net, true),
    state: response.state as 'awaiting-owner-transfer' | 'reserved-before-signing' | 'submitted-or-unknown' | 'refunded' | 'failed',
    transactionHash: response.transactionHash as string | undefined,
    charged: native && response.charged !== null ? quantity(response.charged) : undefined,
    netPaid: native && response.netPaid !== null ? quantity(response.netPaid) : undefined }
}
export async function requestPrepaidRefund(session: WalletSession, credit: PreparedCredit, gross: bigint, publicRecipient?: string) {
  return exclusive(session, async () => {
    validateIdentity(credit)
    const record = await saved(session)
    if (!record || record.attempt || record.topUp || record.refund || record.ledgerId !== credit.ledgerId || record.owner !== credit.owner ||
      credit.expires <= Date.now() + 60_000 || (credit.scope.funding !== 'native' && !validateRailgunAddress(session.info.railgunAddress)))
      throw new Error('Reconcile the prepaid operation and refresh the quote before requesting a refund.')
    const net = gross - prepaidRefundFee(credit)
    if (gross >= 2n ** 120n || net <= 0n) throw new Error('The refund must cover its reviewed network fee allowance.')
    if (typeof credit.maximumRefundGross !== 'bigint' || gross > credit.maximumRefundGross)
      throw new Error('The refund exceeds the current payable amount. Review a smaller refund or try again later.')
    const recipient = credit.scope.funding === 'native' ? getAddress(publicRecipient ?? '') : session.info.railgunAddress
    if (credit.scope.funding === 'native' && (recipient === ZeroAddress || recipient === getAddress(credit.scope.operator)))
      throw new Error('Choose your public refund address, different from the broadcaster.')
    const payload = json({ kind: 'refund', sequence: requestSequence(credit.nextSequence), recipient, gross: gross.toString(), net: net.toString(),
      feesID: credit.feesID, collectionAllowance: credit.collectionAllowance.toString(),
      ...(credit.scope.funding === 'native' && { refundGasAllowance: credit.refundGasAllowance!.toString() }) })
    record.refund = { payload, key: creditRequestKey(record.ledgerId, record.owner, payload),
      ...(credit.scope.funding === 'native' && { rate: credit.rate.toString() }) }
    await writePrivateState(session, journalKey(), record)
    const result = refundResult(await authorize(session, record, payload), record)
    await writePrivateState(session, journalKey(), record)
    return result
  })
}
export async function checkPrepaidRefund(session: WalletSession) {
  return exclusive(session, async () => {
    const record = await saved(session)
    if (!record?.refund) throw new Error('No prepaid refund is saved.')
    let response: Record<string, unknown>
    try { response = await authorize(session, record, record.refund.payload) }
    catch { response = await authorize(session, record, recoveryPayload(record.refund, 'refund')) }
    if (unreserved(response, record.refund, 'refund')) {
      if (record.refund.hash) throw new Error('The broadcaster lost an acknowledged refund. Keep its recovery record.')
      const payload = JSON.parse(record.refund.payload)
      const result = { key: record.refund.key, funding: record.scope.funding, recipient: String(payload.recipient), gross: quantity(payload.gross, true),
        net: quantity(payload.net, true), state: 'not-reserved' as const, transactionHash: undefined, charged: undefined, netPaid: undefined }
      delete record.refund
      await writePrivateState(session, journalKey(), record)
      return result
    }
    const result = refundResult(response, record)
    if (record.scope.funding === 'native' && (result.state === 'refunded' || result.state === 'failed')) {
      const hash = String(response.settlementHash)
      const [receipt, transaction, finalized] = await Promise.all([session.provider.getTransactionReceipt(hash),
        session.provider.getTransaction(hash), session.provider.getBlock('finalized')])
      if (!receipt || !transaction || !finalized || receipt.blockNumber > finalized.number ||
        (await session.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash ||
        getAddress(transaction.from) !== getAddress(record.scope.operator) || transaction.chainId !== CHAIN || transaction.data !== '0x')
        throw new Error('The native refund settlement is not finalized. Keep the saved refund.')
      const original = hash === result.transactionHash
      const expectedCharge = (receipt.gasUsed * receipt.gasPrice * quantity(record.refund.rate, true) + 10n ** 18n - 1n) / 10n ** 18n + (result.netPaid ?? 0n)
      if (result.charged !== expectedCharge) throw new Error('The refund charge differs from actual gas and the reviewed margin.')
      if (transaction.nonce !== record.refund.nonce) throw new Error('The refund differs from the saved operator nonce.')
      if (original ? getAddress(transaction.to ?? '') !== getAddress(result.recipient) || transaction.value !== result.net ||
          (result.state === 'refunded' ? receipt.status !== 1 : receipt.status !== 0)
        : result.state !== 'failed' || receipt.status !== 1 ||
          getAddress(transaction.to ?? '') !== getAddress(record.scope.operator) || transaction.value !== 0n)
        throw new Error('The native refund outcome differs from the saved request. Keep the saved refund.')
    }
    if (result.state === 'refunded' || result.state === 'failed') delete record.refund
    await writePrivateState(session, journalKey(), record)
    return result
  })
}
async function resolveTopUp(session: WalletSession, record: CreditJournal): Promise<void> {
  const topUp = record.topUp!
  if (record.scope.funding === 'native') return
  const completed = await getCompletedTxidFromNullifiers(VERSION, CONFIG.chain, topUp.nullifiers)
  if (!completed?.txid) return
  const hash = `0x${completed.txid.replace(/^0x/, '')}`
  const transaction = await session.provider.getTransaction(hash)
  if (!transaction || getAddress(transaction.to ?? '') !== topUp.transaction.to ||
    transaction.data.toLowerCase() !== topUp.transaction.data.toLowerCase() || transaction.value !== 0n || transaction.chainId !== CHAIN)
    throw new Error('The spent top-up inputs differ from the saved proof. Keep the record for recovery.')
  if (hash !== topUp.hash) {
    if (topUp.hash && topUp.nonce !== undefined) topUp.previous = [...(topUp.previous ?? []), { hash: topUp.hash, nonce: topUp.nonce }]
    topUp.hash = hash
    await writePrivateState(session, journalKey(), record)
  }
}
export async function retryPrepaidTopUp(session: WalletSession, signer: JsonRpcSigner,
  onProgress: (message: string) => void): Promise<string> {
  return exclusive(session, async () => {
    const record = await saved(session)
    if (!record?.topUp || record.attempt) throw new Error('No saved top-up is available to retry.')
    await identity(session)
    await assertPublicNetwork(session, signer)
    const topUp = record.topUp
    if (getAddress(await signer.getAddress()) !== getAddress(topUp.from))
      throw new Error('Reconnect the original public gas wallet before retrying the saved top-up.')
    await resolveTopUp(session, record)
    const receipt = topUp.hash ? await session.provider.getTransactionReceipt(topUp.hash) : null
    if (receipt?.status === 1) {
      onProgress('The saved top-up already executed. Use Check top-up after finality; no retry was sent.')
      return receipt.hash
    }
    const transaction = topUp.hash ? await session.provider.getTransaction(topUp.hash) : null
    if (transaction && (getAddress(transaction.from) !== getAddress(topUp.from) || transaction.chainId !== CHAIN ||
      getAddress(transaction.to ?? '') !== topUp.transaction.to || transaction.data.toLowerCase() !== topUp.transaction.data.toLowerCase() || transaction.value !== BigInt(topUp.transaction.value)))
      throw new Error('The public transaction differs from the saved top-up proof.')
    const [latest, pending] = await Promise.all([signer.provider.getTransactionCount(topUp.from, 'latest'),
      signer.provider.getTransactionCount(topUp.from, 'pending')])
    const nonce = topUp.nonce ?? transaction?.nonce
    if (nonce === undefined || !Number.isSafeInteger(nonce) || nonce < 0 || !Number.isSafeInteger(latest) || latest < 0 ||
      !Number.isSafeInteger(pending) || pending < latest)
      throw new Error('The original public nonce is unknown. Keep the saved proof and recover its wallet transaction first.')
    if (transaction && transaction.nonce !== nonce) throw new Error('The saved public nonce differs from its transaction.')
    if (latest > nonce) {
      const [finalized, canonical] = await Promise.all([session.provider.getBlock('finalized'),
        receipt ? session.provider.getBlock(receipt.blockNumber) : null])
      if (!receipt || receipt.status !== 0 || !finalized || receipt.blockNumber > finalized.number || canonical?.hash !== receipt.blockHash)
        throw new Error('The public nonce was consumed without a finalized failed top-up. Reconcile it before retrying.')
      topUp.previous = [...(topUp.previous ?? []), { hash: topUp.hash, nonce }]
      topUp.nonce = pending
      delete topUp.hash
    } else {
      if (!transaction && pending > nonce) throw new Error('The public nonce has an unknown pending transaction. Reconcile it before retrying.')
      topUp.nonce = nonce
    }
    await writePrivateState(session, journalKey(), record)
    await assertPublicNetwork(session, signer)
    if (getAddress(await signer.getAddress()) !== getAddress(topUp.from)) throw new Error('The public gas wallet changed.')
    if (record.scope.funding === 'native' && (await signer.provider.getCode(topUp.from) !== '0x' ||
      await session.provider.getCode(record.scope.operator) !== '0x')) throw new Error('The native payment account changed. Keep the saved payment.')
    onProgress('Confirm the exact saved top-up in your public wallet. A replacement may require a higher gas fee.')
    const sent = await signer.sendTransaction({ ...topUp.transaction, value: BigInt(topUp.transaction.value), nonce: topUp.nonce, chainId: CHAIN,
      ...(record.scope.funding === 'native' && { type: 2 }) })
    topUp.hash = sent.hash
    await writePrivateState(session, journalKey(), record)
    return sent.hash
  })
}
export async function claimPrepaidTopUp(session: WalletSession, recoveredHash?: string): Promise<CreditBalance> {
  return exclusive(session, async () => {
    const record = await saved(session)
    if (!record?.topUp) throw new Error('No top-up is saved.')
    const topUp = record.topUp
    if (recoveredHash !== undefined && recoveredHash !== '') {
      if (record.scope.funding !== 'native' || !isHexString(recoveredHash, 32)) throw new Error('A valid native payment transaction hash is required.')
      const tx = await session.provider.getTransaction(recoveredHash)
      if (!tx || tx.chainId !== CHAIN || getAddress(tx.from) !== getAddress(topUp.from) ||
        getAddress(tx.to ?? '') !== topUp.transaction.to || tx.data.toLowerCase() !== topUp.transaction.data.toLowerCase() ||
        tx.value !== BigInt(topUp.transaction.value) || ![0, 2].includes(tx.type) || tx.authorizationList?.length)
        throw new Error('That transaction does not match the saved native payment. Keep the saved record.')
      topUp.hash = tx.hash
      await writePrivateState(session, journalKey(), record)
    }
    await resolveTopUp(session, record)
    if (!topUp.hash) throw new Error('Top-up outcome is unknown. Keep the saved proof and check again after history sync.')
    const [receipt, finalized, transaction] = await Promise.all([session.provider.getTransactionReceipt(topUp.hash),
      session.provider.getBlock('finalized'), session.provider.getTransaction(topUp.hash)])
    if (!receipt || receipt.status !== 1 || !finalized || receipt.blockNumber > finalized.number)
      throw new Error('Top-up is not finalized successfully yet. Keep the saved proof and check again.')
    if (!transaction || getAddress(transaction.to ?? '') !== topUp.transaction.to ||
      transaction.data.toLowerCase() !== topUp.transaction.data.toLowerCase() || transaction.value !== BigInt(topUp.transaction.value) || transaction.chainId !== CHAIN ||
      (record.scope.funding === 'native' && (getAddress(transaction.from) !== getAddress(topUp.from) ||
        ![0, 2].includes(transaction.type) || transaction.authorizationList?.length)) ||
      (await session.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash)
      throw new Error('The finalized top-up differs from the saved proof. Keep the record for recovery.')
    const response = balance(await authorize(session, record, json({ kind: 'claim', transactionHash: topUp.hash,
      ...(record.scope.funding === 'native' ? { paymentId: topUp.paymentId } : {}) })), record)
    delete record.topUp
    await writePrivateState(session, journalKey(), record)
    return response
  })
}
