import { withdrawalPilotKey } from './prepaid-pilot'
import { validateRailgunAddress } from '@railgun-community/wallet'
import { getAddress, isHexString, type JsonRpcProvider } from 'ethers'
import { CREDIT_PROTOCOL, authenticateCreditRequest, creditMemo, creditRefundMemo, creditRequestKeyFromPayloadHash } from '../../railgun/credit-protocol'
import { CHAIN_ID, FEE_LIFETIME_MS, NETWORK, TOKENS, type Settings } from './config'
import { CreditLedger, creditCharge, creditSequence, type CreditRefundRow } from './credit'
import { ceilDiv, issueFee } from './fees'
import type { RailgunSDK } from './sdk'
import type { Store } from './storage'
import { PROXY, uint } from './transaction'
import { object } from './wire'
import { creditBackingEvidence, type CreditBacking } from './credit-backing'
import { finalizedCreditReceipt } from './credit-payment'
import { ANON_COLLECTION_BASE_FEE_BPS, readAnonCollectionBaseFee } from './anon-native-collection'
import { pooledCreditReads } from './credit-read-pool'

export type CreditRequest = ReturnType<typeof authenticateCreditRequest>
export interface SecuredRequest { owner: string; sequence: number; maximumCharge: bigint; rate: bigint; collectionAllowance: bigint; expiration: number; backing: CreditBacking }

export class CreditService {
  readonly ledger: CreditLedger
  private backingCache?: { proof: CreditBacking; at: number }
  private backingRead?: Promise<CreditBacking>
  private history?: { count: number; lastHash: string; anchor: { number: number; hash: string } }
  constructor(private readonly config: Settings, private readonly store: Store,
    private readonly sdk: Pick<RailgunSDK, 'address' | 'confirmedCredits' | 'confirmedRefund' | 'accountedCreditBacking' | 'confirmedOwnerCollection'>, private readonly provider: JsonRpcProvider, operator: string, initialNonce: number) {
    if (!validateRailgunAddress(sdk.address)) throw new Error('Invalid private fee identity.')
    this.ledger = new CreditLedger(store, { chainId: CHAIN_ID, operator, recipient: sdk.address, token: TOKENS[0].address }, initialNonce)
  }
  authenticate(input: unknown): CreditRequest {
    return authenticateCreditRequest(this.ledger.scope, this.ledger.id, input)
  }
  private executionEnabled(): boolean {
    if (!this.config.enabled || !this.config.creditCollectionGas || !this.config.creditCollectionInputs ||
      !this.config.creditCollectionOutputs || !this.config.creditCollectionProofs) return false
    try {
      this.ledger.assertOwnerJournalReady()
      if (this.config.admission === 'pilot') {
        if (!this.config.prepaidPilotOwner || !this.config.prepaidPilotLedgerId) return false
        const key = withdrawalPilotKey(this.ledger.id, this.config.prepaidPilotLedgerId)
        if (this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(key)) return false
      } else if (this.config.prepaidPilotLedgerId || this.config.prepaidPilotOwner) return false
      return true
    } catch { return false }
  }
  private assertExecutionAdmission(owner: string): void {
    if (!this.executionEnabled() || (this.config.admission === 'pilot' && owner !== this.config.prepaidPilotOwner))
      throw new Error('Prepaid execution is unavailable for this approved credit owner.')
  }
  info() {
    return { protocol: CREDIT_PROTOCOL, ledgerId: this.ledger.id, scope: this.ledger.scope,
      executionEnabled: this.executionEnabled(),
      funding: 'user-submitted-private-transfer', confirmation: 'finalized', refund: 'owner-executed-private-transfer' }
  }
  private async price(): Promise<{ rate: bigint; collectionAllowance: bigint }> {
    if (!this.config.creditCollectionGas || this.config.creditCollectionGas <= 0n || !this.config.creditCollectionInputs ||
      !this.config.creditCollectionOutputs || !this.config.creditCollectionProofs || this.config.maxGasPrice <= 0n || this.config.marginBps <= 0n)
      throw new Error('Prepaid pricing requires reviewed collection gas and operator limits.')
    const [result] = await Promise.all([
      this.provider.call({ to: NETWORK.proxyContract, data: PROXY.encodeFunctionData('unshieldFee') }),
      readAnonCollectionBaseFee(this.provider),
    ])
    const fee = BigInt(PROXY.decodeFunctionResult('unshieldFee', result)[0])
    if (fee < 0n || fee > 5000n) throw new Error('Private fee collection pricing is unavailable.')
    // ANON deducts its fee from the pool-net payout; both deductions precede native gas recovery.
    return { rate: ceilDiv(10n ** 18n * (10_000n + this.config.marginBps) * 10_000n,
      (10_000n - fee) * (10_000n - ANON_COLLECTION_BASE_FEE_BPS)),
      collectionAllowance: this.config.creditCollectionGas * this.config.maxGasPrice }
  }
  async read(request: CreditRequest): Promise<Record<string, unknown>> {
    const { owner, payload } = request
    if (payload.kind === 'recover') {
      if (typeof payload.payloadHash !== 'string') throw new Error('The saved request payload hash is required for recovery.')
      if (payload.operation !== 'execute' && payload.operation !== 'refund')
        throw new Error('Only saved executions and refunds can be recovered.')
      const key = creditRequestKeyFromPayloadHash(this.ledger.id, owner, payload.payloadHash)
      const recovery = this.ledger.retireUnreserved(key, owner, payload.operation, payload.sequence)
      if (recovery)
        return { kind: 'recovery', recoveredKey: key, operation: payload.operation, state: 'not-reserved', ...recovery }
      return this.read({ ...request, payload: { kind: payload.operation === 'execute' ? 'attempt' : 'refund-status', key } })
    } else if (payload.kind === 'claim') {
      if (typeof payload.transactionHash !== 'string' || !isHexString(payload.transactionHash, 32)) throw new Error('Invalid top-up transaction.')
      const payments = await this.sdk.confirmedCredits(this.provider, this.ledger.scope, this.ledger.id, owner, payload.transactionHash)
      for (const payment of payments) if (this.ledger.deposit(payment)) this.backingCache = undefined
    } else if (payload.kind === 'quote') {
      if (payload.refund !== true) this.assertExecutionAdmission(owner)
      if (payload.refund === true && (!this.ledger.hasDeposit(owner) || this.ledger.balance(owner).available <= 0n))
        throw new Error('A funded credit balance is required before requesting a refund quote.')
      const pricing = await this.price()
      if (payload.refund === true && this.ledger.balance(owner).available <= creditCharge(0n, pricing.rate, pricing.collectionAllowance))
        throw new Error('The available credit does not cover a positive refund and its processing fee.')
      const quote = issueFee(this.store, { [TOKENS[0].address]: pricing.rate })
      let maximumRefundGross: string | undefined
      if (payload.refund === true && this.ledger.hasPendingRefund(owner)) maximumRefundGross = '0'
      else if (payload.refund === true) {
        const backing = creditBackingEvidence(await this.checkedBacking())
        const headroom = this.ledger.refundExecutionHeadroom(owner, creditCharge(this.config.maxTransactionCost, pricing.rate, pricing.collectionAllowance))
        const capacity = backing.bounded - this.ledger.earned() - this.ledger.maximumPendingCharges() - this.ledger.pendingRefundGross() - headroom
        const available = this.ledger.balance(owner).available
        maximumRefundGross = (capacity <= 0n ? 0n : capacity < available ? capacity : available).toString()
      }
      return { kind: 'quote', feesID: quote.id, expires: quote.expiration, rate: pricing.rate.toString(), nextSequence: this.ledger.nextSequence(owner),
        collectionAllowance: pricing.collectionAllowance.toString(), maximumGasCost: this.config.maxTransactionCost.toString(),
        maximumGasPrice: this.config.maxGasPrice.toString(),
        maximumCharge: creditCharge(this.config.maxTransactionCost, pricing.rate, pricing.collectionAllowance).toString(),
        ...(maximumRefundGross === undefined ? {} : { maximumRefundGross }) }
    } else if (payload.kind === 'refund' || payload.kind === 'refund-status') {
      const key = payload.kind === 'refund' ? request.key : payload.key
      if (typeof key !== 'string' || !isHexString(key, 32)) throw new Error('Invalid refund identifier.')
      let refund = this.ledger.refund(key)
      if (!refund && payload.kind === 'refund') {
        const sequence = creditSequence(payload.sequence)
        if (sequence !== this.ledger.nextSequence(owner)) throw new Error('Refresh the prepaid request sequence.')
        if (typeof payload.recipient !== 'string') throw new Error('A private refund recipient is required.')
        const gross = uint(payload.gross, true), net = uint(payload.net, true)
        if (this.ledger.hasPendingRefund(owner)) throw new Error('Resolve this owner’s pending refund before reserving another.')
        if (this.ledger.balance(owner).available < gross) throw new Error('Unused confirmed credit is insufficient for this refund.')
        const pricing = await this.acceptedPrice(payload.feesID, payload.collectionAllowance)
        if (gross - net !== creditCharge(0n, pricing.rate, pricing.collectionAllowance))
          throw new Error('The signed refund fee does not cover the accepted collection budget.')
        const maximumExecutionCharge = creditCharge(this.config.maxTransactionCost, pricing.rate, pricing.collectionAllowance)
        const headroom = this.ledger.refundExecutionHeadroom(owner, maximumExecutionCharge)
        this.ledger.reserveRefund(key, owner, payload.recipient, gross, net, sequence, await this.assertBacked(gross + headroom), maximumExecutionCharge)
        refund = this.ledger.refund(key)!
      }
      if (!refund || refund.owner !== owner) throw new Error('No refund belongs to this credit owner.')
      if (!refund.transaction_hash) {
        await this.reconcileRefund(refund)
        refund = this.ledger.refund(key)!
      }
      return { kind: 'refund', key, recipient: refund.recipient, gross: refund.gross, net: refund.net,
        state: refund.transaction_hash ? 'refunded' : 'awaiting-owner-transfer', transactionHash: refund.transaction_hash,
        memo: creditRefundMemo(this.ledger.scope, this.ledger.id, key) }
    } else if (payload.kind === 'attempt') {
      if (typeof payload.key !== 'string' || !isHexString(payload.key, 32)) throw new Error('Invalid prepaid attempt identifier.')
      const attempt = this.ledger.attempt(payload.key)
      if (!attempt || attempt.owner !== owner) throw new Error('No saved attempt belongs to this credit owner.')
      const operation = this.store.get(payload.key)!
      return { kind: 'attempt', key: payload.key, hash: operation.hash, cancellationHash: operation.cancel_hash,
        settlementHash: attempt.settlement_hash,
        state: attempt.charged !== null ? 'settled' : operation.raw ? 'submitted-or-unknown' : 'reserved-before-signing',
        maximumCharge: attempt.maximum_charge, charged: attempt.charged }
    } else if (payload.kind !== 'balance') throw new Error('Unsupported prepaid request.')
    return { kind: 'balance', owner, memo: creditMemo(this.ledger.scope, this.ledger.id, owner),
      ...Object.fromEntries(Object.entries(this.ledger.balance(owner)).map(([key, value]) => [key, value.toString()])) }
  }
  private async reconcileRefund(refund: CreditRefundRow): Promise<void> {
    this.store.db.prepare('UPDATE credit_refunds SET checked_at=? WHERE key=?').run(Date.now(), refund.key)
    try {
      const intent = this.ledger.pendingOwnerIntent()
      if (!intent || intent.kind !== 'refund' || intent.refund_key !== refund.key) return
      const proof = await this.sdk.confirmedRefund(this.provider, this.ledger.scope, this.ledger.id, refund.key,
        refund.recipient, BigInt(refund.net), this.ledger.refundPayouts(refund.key),
        (commitment) => this.ledger.refundCommitmentAvailable(refund.key, commitment),
        { intent, accounted: this.ledger.accountedNotes() })
      this.ledger.settleRefund(refund.key, proof)
      this.backingCache = undefined
    } catch { /* An unverified or unfinalized transfer cannot settle the refund hold. */ }
  }
  async reconcileRefunds(): Promise<void> {
    const intent = this.ledger.pendingOwnerIntent()
    if (intent?.kind === 'collection') {
      for (const candidate of this.ledger.ownerPayouts(intent.key)) {
        try {
          this.ledger.settleOwnerCollection(intent.key, await this.sdk.confirmedOwnerCollection(this.provider, this.ledger.scope,
            intent, this.ledger.accountedNotes(), candidate))
          this.backingCache = undefined
        } catch { /* Keep the owner hold on unknown outcome, reorg, cost overrun or unverified native delivery. */ }
      }
    }
    const pending = this.store.db.prepare('SELECT * FROM credit_refunds WHERE transaction_hash IS NULL ORDER BY checked_at,created,key LIMIT 10')
      .all() as unknown as CreditRefundRow[]
    for (const refund of pending) await this.reconcileRefund(refund)
  }
  async secure(request: CreditRequest): Promise<SecuredRequest> {
    this.assertExecutionAdmission(request.owner)
    if (!this.config.enabled) throw new Error('New prepaid execution is disabled.')
    const payload = request.payload
    if (payload.kind !== 'execute' || !object(payload.request) || typeof payload.request.feesID !== 'string')
      throw new Error('Invalid prepaid execution request.')
    const sequence = creditSequence(payload.sequence)
    if (sequence !== this.ledger.nextSequence(request.owner)) throw new Error('Refresh the prepaid request sequence.')
    const maximumCharge = uint(payload.maximumCharge, true)
    if (this.ledger.balance(request.owner).available < maximumCharge) throw new Error('Confirmed credit is insufficient.')
    this.ledger.assertChainNonce(await this.provider.getTransactionCount(this.ledger.scope.operator, 'latest'))
    const pricing = await this.acceptedPrice(payload.request.feesID, payload.collectionAllowance)
    const backing = await this.assertBacked(maximumCharge)
    return { owner: request.owner, sequence, maximumCharge, ...pricing, backing }
  }
  async assertBacked(candidateMaximumCharge: bigint): Promise<CreditBacking> {
    const proof = await this.checkedBacking(), backing = creditBackingEvidence(proof)
    if (candidateMaximumCharge <= 0n || backing.bounded < this.ledger.earned() + this.ledger.maximumPendingCharges() +
      this.ledger.pendingRefundGross() + candidateMaximumCharge)
      throw new Error('Finalized accounted notes cannot recover all earned and reserved fees within the qualified input limit.')
    return proof
  }
  private async checkedBacking(): Promise<CreditBacking> {
    this.ledger.assertOwnerJournalReady()
    if (!this.config.creditCollectionInputs) throw new Error('A qualified collection input limit is required.')
    if (this.backingCache && Date.now() - this.backingCache.at < 5_000) {
      try {
        if (creditBackingEvidence(this.backingCache.proof).available >= this.ledger.requiredBacking()) return this.backingCache.proof
      } catch { /* Rebuild expired canonical evidence. */ }
    }
    this.backingRead ??= (async () => {
      await this.verifyOwnerHistory()
      const proof = await this.sdk.accountedCreditBacking(this.provider, this.ledger.accountedNotes(), this.config.creditCollectionInputs!)
      this.ledger.assertOwnerJournalReady()
      if (creditBackingEvidence(proof).available < this.ledger.requiredBacking())
        throw new Error('Finalized accounted notes do not cover customer liabilities and earned fees.')
      this.backingCache = { proof, at: Date.now() }
      return proof
    })()
    try { return await this.backingRead } finally { this.backingRead = undefined }
  }
  private async verifyOwnerHistory(): Promise<void> {
    const saved = this.ledger.ownerSettlements()
    if (!saved.length) { this.history = undefined; return }
    const deadline = Date.now() + 40_000
    const read = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([work, new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Canonical owner history verification timed out.')), Math.max(1, Math.min(10_000, deadline - Date.now())))
      })]) } finally { clearTimeout(timer) }
    }
    const finalized = await read(this.provider.getBlock('finalized'))
    if (!finalized?.hash) throw new Error('Finalized owner history is unavailable.')
    const previous = this.history && saved.length >= this.history.count &&
      saved[this.history.count - 1]?.transaction_hash === this.history.lastHash ? this.history : undefined
    const hold = () => {
      this.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('creditOwnerRecoveryRequired', '1')
      throw new Error('Owner payment history needs canonical reconciliation before spending.')
    }
    let anchor = previous?.anchor
    // A canonical highest block commits to every earlier block verified in the checkpoint's same stable history.
    if (anchor) {
      if (anchor.number > finalized.number) throw new Error('The owner history checkpoint is not finalized by this RPC.')
      const checkpoint = await read(this.provider.getBlock(anchor.number))
      if (!checkpoint?.hash) throw new Error('The owner history checkpoint is unavailable.')
      if (checkpoint.hash !== anchor.hash) hold()
    }
    await pooledCreditReads(saved.slice(previous?.count ?? 0), async (payment) => {
      if (Date.now() > deadline) throw new Error('Canonical owner history verification timed out.')
      const receipt = await read(finalizedCreditReceipt(this.provider, payment.transaction_hash))
      if (receipt.blockHash !== payment.block_hash || receipt.blockNumber !== payment.block_number || receipt.status !== 1) hold()
      if (!anchor || payment.block_number > anchor.number) anchor = { number: payment.block_number, hash: payment.block_hash }
    })
    if (!anchor || (await read(this.provider.getBlock(anchor.number)))?.hash !== anchor.hash ||
      (await read(this.provider.getBlock(finalized.number)))?.hash !== finalized.hash || Date.now() > deadline)
      throw new Error('Owner history changed during verification.')
    this.history = { count: saved.length, lastHash: saved[saved.length - 1].transaction_hash, anchor }
  }
  private async acceptedPrice(feesID: unknown, allowance: unknown): Promise<Pick<SecuredRequest, 'rate' | 'collectionAllowance' | 'expiration'>> {
    if (typeof feesID !== 'string' || !/^[0-9a-f]{64}$/.test(feesID)) throw new Error('Invalid prepaid quote.')
    const quote = this.store.db.prepare('SELECT rates,expiration FROM fees WHERE id=?').get(feesID)
    if (!quote || typeof quote.expiration !== 'number' || quote.expiration <= Date.now() ||
      quote.expiration > Date.now() + FEE_LIFETIME_MS) throw new Error('Prepaid quote expired.')
    const rates = JSON.parse(String(quote.rates)), storedRate = rates[getAddress(TOKENS[0].address)]
    if (typeof storedRate !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(storedRate)) throw new Error('Invalid prepaid quote rate.')
    const rate = uint(BigInt(storedRate).toString(), true)
    const current = await this.price(), collectionAllowance = uint(allowance)
    if (rate < current.rate || collectionAllowance !== current.collectionAllowance) throw new Error('Accepted credit pricing is insufficient.')
    return { rate, collectionAllowance, expiration: quote.expiration }
  }
}
