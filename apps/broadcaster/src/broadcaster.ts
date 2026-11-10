import { withdrawalPilotKey } from './prepaid-pilot'
import { fromUTF8String } from '@railgun-community/wallet'
import { getAddress, Interface, JsonRpcProvider, Transaction, type TransactionResponse } from 'ethers'
import { assertSigningNetwork, BROADCASTER_VERSION, CHAIN, CHAIN_ID, MAX_GAS, NETWORK, TOKENS, type Settings } from './config'
import { issueFee, validateFee, ceilDiv } from './fees'
import { Store } from './storage'
import { ADAPT, PROXY, assertPrivateExecution, parseRequest, type ParsedRequest } from './transaction'
import { encryptResponse, openRequest, responseEnvelope } from './wire'
import type { FeeOracle } from './fees'
import type { RailgunSDK, FeeProof } from './sdk'
import { assertExecutionGuardCode, guardedExecution } from '../../railgun/operator/execution-guard'
import { signApprovedTransaction, type GasSigner } from './signer'
import { readChainState } from './chain-state'
import { CREDIT_PROTOCOL } from '../../railgun/credit-protocol'
import { CreditService, type SecuredRequest, type CreditRequest } from './credit-service'
import { object } from './wire'
import { finalizedCreditReceipt } from './credit-payment'
import { CreditQueryLimit } from './credit-query-limit'
import { assertNativeRefundTrace } from './credit-native-payment'

const REGISTRY = new Interface(['function getContractAddress(string name) view returns (address)'])
type SDK = Pick<RailgunSDK, 'address' | 'privateViewingKey' | 'publicViewingKey' | 'ready' | 'sign' | 'fee' | 'validate' | 'assure'> &
  Partial<Pick<RailgunSDK, 'confirmedCredits' | 'confirmedRefund' | 'accountedCreditBacking' | 'confirmedOwnerCollection' | 'validatePrepaid'>>
type Sender = { broadcastTransaction(raw: string, validUntilMs?: number): Promise<Pick<TransactionResponse, 'hash'>> }

export class Broadcaster {
  // shortcut: one gas wallet; add independently journaled senders when measured demand needs concurrency.
  private busy = false
  private activeKey?: string
  private lastRequests: number[] = []
  private attempts: number[] = []
  private readonly creditQueries = new CreditQueryLimit()
  private discoveryQueries: number[] = []
  private creditService?: CreditService
  constructor(
    readonly config: Settings, readonly store: Store, private readonly sdk: SDK,
    readonly provider: JsonRpcProvider, readonly wallet: GasSigner, private readonly sender: Sender,
    private readonly oracle: Pick<FeeOracle, 'rates'>,
  ) {}

  private async credits(): Promise<CreditService> {
    if (!this.sdk.ready() || !this.sdk.validatePrepaid || (this.config.creditPaymentMode !== 'public-native' &&
      (!this.sdk.confirmedCredits || !this.sdk.confirmedRefund || !this.sdk.accountedCreditBacking || !this.sdk.confirmedOwnerCollection)))
      throw new Error('The prepaid fee wallet is unavailable.')
    if (this.creditService) return this.creditService
    const initialNonce = await this.provider.getTransactionCount(this.wallet.address, 'latest')
    const hasIdentityTable = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_identity'").get()
    const hasIdentity = hasIdentityTable && this.store.db.prepare('SELECT 1 FROM credit_identity WHERE singleton=1').get()
    if (!hasIdentity) {
      const [pending, finalized] = await Promise.all([
        this.provider.getTransactionCount(this.wallet.address, 'pending'),
        this.provider.getTransactionCount(this.wallet.address, 'finalized'),
      ])
      if (!Number.isSafeInteger(initialNonce) || initialNonce < 0 || pending !== initialNonce || finalized !== initialNonce)
        throw new Error('Finalize every operator transaction before initializing prepaid credit.')
    }
    return this.creditService ??= new CreditService(this.config, this.store,
      { address: this.sdk.address, confirmedCredits: this.sdk.confirmedCredits?.bind(this.sdk), confirmedRefund: this.sdk.confirmedRefund?.bind(this.sdk),
        accountedCreditBacking: this.sdk.accountedCreditBacking?.bind(this.sdk), confirmedOwnerCollection: this.sdk.confirmedOwnerCollection?.bind(this.sdk) },
      this.provider, this.wallet.address, initialNonce)
  }

  async creditInfo() { return (await this.credits()).info() }

  private async state() {
    if (this.config.chainId !== CHAIN_ID || (await this.provider.getNetwork()).chainId !== CHAIN)
      throw new Error('Wrong broadcaster read network.')
    const state = await readChainState(this.provider)
    const { block, settled } = state
    const [nonce, confirmed, balance] = await Promise.all([
      this.provider.getTransactionCount(this.wallet.address, block.number),
      this.provider.getTransactionCount(this.wallet.address, settled),
      this.provider.getBalance(this.wallet.address, block.number),
    ])
    return { ...state, nonce, confirmed, balance }
  }

  async available(): Promise<boolean> {
    if (!this.config.enabled || this.busy || !this.sdk.ready() || this.store.hasPending()) return false
    if (this.config.mode === 'mainnet' && this.config.creditPaymentMode !== 'public-native' && (!this.config.creditCollectionGas || !this.config.creditCollectionInputs ||
      !this.config.creditCollectionOutputs || !this.config.creditCollectionProofs)) return false
    if (this.creditService?.ledger.pendingOwnerIntent()) return false
    if (this.config.creditPaymentMode === 'public-native') {
      if (!this.creditService || this.creditService.ledger.hasUnsettledNativeAttempt()) return false
      try { await this.creditService.qualifyNativeFundingReads(); await this.creditService.assertBacked(1n) } catch { return false }
    }
    // Advertising availability must never create or rotate a credit identity.
    if (this.config.prepaidPilotLedgerId !== undefined && (this.config.admission !== 'pilot' ||
      !this.config.prepaidPilotOwner || !this.creditService || this.creditService.ledger.id !== this.config.prepaidPilotLedgerId)) return false
    const pilotKey = this.config.prepaidPilotLedgerId === undefined ? 'withdrawalPilot'
      : withdrawalPilotKey(this.creditService!.ledger.id, this.config.prepaidPilotLedgerId)
    if (this.config.admission === 'pilot' && this.config.pilotWithdrawalRecipient &&
      this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(pilotKey)) return false
    const { nonce, confirmed, balance, minimumGasPrice } = await this.state()
    return minimumGasPrice <= this.config.maxGasPrice && nonce === confirmed &&
      balance >= this.config.reserve + this.config.maxTransactionCost &&
      this.store.exposure() < this.config.dailyBudget &&
      !this.store.nonceBlocked(confirmed)
  }

  async feeAdvertisement(): Promise<Uint8Array> {
    const available = await this.available()
    const quote = issueFee(this.store, this.config.creditPaymentMode === 'public-native'
      ? { [TOKENS[0].address]: ceilDiv(10n ** 18n * (10_000n + this.config.marginBps), 10_000n) } : await this.oracle.rates())
    const data = fromUTF8String(JSON.stringify({
      fees: Object.fromEntries(Object.entries(quote.rates).map(([token, rate]) => [token.toLowerCase(), rate])),
      feeExpiration: quote.expiration, feesID: quote.id, railgunAddress: this.sdk.address,
      identifier: `ophis-${CHAIN_ID}`, availableWallets: available ? 1 : 0, version: BROADCASTER_VERSION,
      relayAdapt: NETWORK.relayAdaptContract, relayAdapt7702: NETWORK.relayAdapt7702Contract,
      requiredPOIListKeys: [], reliability: 0.75,
      ophisPaymentProtocol: CREDIT_PROTOCOL,
    }))
    return Buffer.from(JSON.stringify({ data, signature: await this.sdk.sign(data) }))
  }

  async handle(payload: Uint8Array): Promise<Uint8Array | undefined> {
    const request = await openRequest(payload, this.sdk.privateViewingKey, this.sdk.publicViewingKey)
    if (!request) return
    let secured: SecuredRequest | undefined
    let creditRequest: CreditRequest | undefined
    const prepaid = request.data.protocol === CREDIT_PROTOCOL
    const correlation = request.data.correlation
    const reply = (body: Record<string, unknown>) => encryptResponse(prepaid
      ? { ...body, protocol: CREDIT_PROTOCOL, correlation, key: request.key } : body, request)
    if (prepaid) {
      try {
        if (typeof correlation !== 'string' || !/^0x[0-9a-f]{64}$/i.test(correlation))
          throw new Error('Prepaid service unavailable.')
        const credits = await this.credits()
        if (request.data.kind === 'info') {
          const now = performance.now()
          this.discoveryQueries = this.discoveryQueries.filter((time) => now - time < 60_000)
          if (this.discoveryQueries.length >= 300) throw new Error('Prepaid discovery limit reached.')
          this.discoveryQueries.push(now)
          return responseEnvelope(reply(await credits.info()), request.id)
        }
        const authorized = credits.authenticate(request.data.authorization)
        request.key = authorized.key
        if (authorized.payload.kind === 'refund' && credits.ledger.isNative) {
          this.creditQueries.accept(authorized.owner, credits.ledger.hasDeposit(authorized.owner), 'refund')
          const previous = credits.ledger.attempt(request.key)
          if (previous) return responseEnvelope(reply(await credits.read(authorized)), request.id)
          credits.assertNativeRefundAdmission(authorized.owner)
          return responseEnvelope(reply(await this.nativeRefund(credits, authorized, request.envelope)), request.id)
        }
        if (authorized.payload.kind !== 'execute') {
          this.creditQueries.accept(authorized.owner, credits.ledger.hasDeposit(authorized.owner), String(authorized.payload.kind))
          return responseEnvelope(reply(await credits.read(authorized)), request.id)
        }
        const previous = credits.ledger.attempt(request.key)
        if (previous) {
          if (previous.owner !== authorized.owner) throw new Error('Wrong prepaid attempt owner.')
          const saved = this.store.get(request.key)!
          return responseEnvelope(reply({ kind: 'attempt', txHash: saved.hash, ...(credits.ledger.isNative ? { nonce: saved.nonce } : {}),
            settlementHash: previous.settlement_hash,
            state: previous.charged !== null ? 'settled' : 'reserved-or-submitted', charged: previous.charged }), request.id)
        }
        this.creditQueries.accept(authorized.owner, credits.ledger.hasDeposit(authorized.owner), 'execute')
        creditRequest = authorized
        if (!object(authorized.payload.request)) throw new Error('Invalid prepaid operation.')
        request.data = authorized.payload.request
      } catch {
        return responseEnvelope(reply({ error: 'Prepaid request rejected. Check the confirmed balance and refresh the quote; retain any saved attempt.' }), request.id)
      }
    } else if (this.config.mode === 'mainnet') {
      return responseEnvelope(reply({ error: 'Ophis now requires confirmed prepaid fees. Keep saved transactions for recovery and update the private wallet.' }), request.id)
    }
    if (this.activeKey === request.key) return
    const existing = this.store.get(request.key)
    if (existing?.response) return responseEnvelope(existing.response, request.id)
    let phase = 'request'
    let reserved = false
    try {
      if (existing?.raw) throw new Error('This signed request needs reconciliation.')
      if (!this.config.enabled || !this.sdk.ready()) throw new Error('Broadcaster not available.')
      assertSigningNetwork(this.config)
      phase = 'busy'
      if (this.busy || this.store.hasPending()) throw new Error('Reconcile the preceding request and fee first.')
      phase = 'admission'
      const now = performance.now()
      this.lastRequests = this.lastRequests.filter((time) => now - time < 60_000)
      this.attempts = this.attempts.filter((time) => now - time < 60_000)
      if (this.attempts.length >= 300) throw new Error('Broadcaster admission limit reached.')
      this.attempts.push(now)
      if (this.lastRequests.length >= 30) throw new Error('Broadcaster request limit reached.')
      phase = 'format'
      const parsed = parseRequest(request.data, this.wallet.address, this.config, !!creditRequest)
      phase = 'pilot'
      if (parsed.type4 && !parsed.withdrawal && this.config.admission === 'pilot' && this.config.pilotAccount &&
        getAddress(String(parsed.transaction.to)) !== this.config.pilotAccount)
        throw new Error('This operator is restricted to its selected pilot account.')
      let withdrawalToken: string | undefined
      if (!parsed.type4 || parsed.withdrawal) {
        const withdrawal = parsed.withdrawal ? { npk: parsed.withdrawal.recipient, value: parsed.withdrawal.amount,
          token: { tokenAddress: parsed.withdrawal.token, tokenType: 0n, tokenSubID: 0n } } : parsed.transactions[0].unshieldPreimage
        phase = 'withdrawal-recipient'
        if (typeof withdrawal.npk !== 'string') throw new Error('Wrong withdrawal recipient.')
        const recipient = BigInt(withdrawal.npk)
        if (recipient <= 0n || recipient >= 2n ** 160n || (this.config.admission === 'pilot' &&
          (!this.config.pilotWithdrawalRecipient || recipient !== BigInt(this.config.pilotWithdrawalRecipient))))
          throw new Error('Wrong withdrawal recipient.')
        phase = 'withdrawal-token'
        if (typeof withdrawal.token.tokenAddress !== 'string') throw new Error('Wrong withdrawal token.')
        withdrawalToken = getAddress(withdrawal.token.tokenAddress)
        if (BigInt(withdrawal.token.tokenType) !== 0n || BigInt(withdrawal.token.tokenSubID) !== 0n ||
          (!(parsed.withdrawal && this.config.admission === 'public') &&
            !TOKENS.some((token) => getAddress(token.address) === withdrawalToken)) ||
          (this.config.admission === 'pilot' && withdrawalToken !== getAddress(TOKENS[1].address)) ||
          BigInt(withdrawal.value) <= 0n) throw new Error('Wrong withdrawal token.')
        phase = 'withdrawal-used'
        const pilotKey = creditRequest ? withdrawalPilotKey((await this.credits()).ledger.id, this.config.prepaidPilotLedgerId) : 'withdrawalPilot'
        if (this.config.admission === 'pilot' && this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(pilotKey))
          throw new Error('Withdrawal pilot used.')
      }
      const feeQuote = this.store.db.prepare('SELECT expiration FROM fees WHERE id=?').get(parsed.feesID) as { expiration: number } | undefined
      if (!feeQuote || feeQuote.expiration <= Date.now()) { phase = 'fee'; throw new Error('Fee quote expired.') }
      this.busy = true; this.activeKey = request.key; reserved = true
      // Admission and parsing must bound RPC work even when an execution never reserves credit.
      phase = 'prepaid'
      if (creditRequest) secured = await (await this.credits()).secure(creditRequest)
      phase = 'fee'
      const payment = secured ? {} : await this.sdk.fee(parsed)
      if (!secured && withdrawalToken && (Object.keys(payment).length !== 1 || !payment[parsed.withdrawal ? TOKENS[0].address : withdrawalToken])) {
        phase = parsed.withdrawal ? 'bound-withdrawal-fee' : 'withdrawal-fee'
        throw new Error(parsed.withdrawal ? `The withdrawal broadcaster fee must use ${TOKENS[0].symbol}.` : 'The withdrawal broadcaster fee must use the withdrawn token.')
      }
      if (!secured) validateFee(this.store, parsed.feesID, payment, 1n, await this.oracle.rates())
      const { nonce, confirmed, balance, block, baseFee, minimumGasPrice } = await this.state()
      if (nonce !== confirmed || this.store.nonceBlocked(nonce))
        throw new Error('The operator has an unresolved transaction.')
      phase = 'network'
      await this.validateNetworkAndAuthority(parsed, block.number)
      let execution = parsed.type4 && this.config.executionGuard
        ? guardedExecution(parsed.transaction, parsed.executeNonce!, this.config.executionGuard) : parsed.transaction
      phase = 'pricing'
      if (!parsed.type4) {
        // Common requests specify a minimum, while a mined legacy transaction needs a positive tip.
        let gasPrice = BigInt(parsed.transaction.gasPrice!)
        for (const item of parsed.transactions) {
          const minimum = BigInt(item.boundParams.minGasPrice)
          if (minimum > gasPrice) gasPrice = minimum
        }
        if (minimumGasPrice > gasPrice) gasPrice = minimumGasPrice
        if (gasPrice > this.config.maxGasPrice) throw new Error('Current gas price exceeds the operator cap.')
        execution = { ...execution, gasPrice }
      }
      const populated = { ...execution, from: this.wallet.address, nonce }
      phase = 'estimate'
      const estimate = await this.provider.estimateGas(populated)
      phase = 'allowance'
      const allowed = parsed.type4 ? BigInt(parsed.transaction.gasLimit!) : MAX_GAS
      const gasLimit = ceilDiv(estimate * 110n, 100n)
      if (gasLimit > allowed || gasLimit > MAX_GAS) throw new Error('Gas estimate exceeds the client allowance.')
      const price = parsed.type4 ? BigInt(parsed.transaction.maxFeePerGas!) : BigInt(populated.gasPrice!)
      const tip = parsed.type4 ? BigInt(parsed.transaction.maxPriorityFeePerGas!) : 1n
      const effectivePrice = (base: bigint) => parsed.type4 && base + tip < price ? base + tip : price
      phase = 'pricing'
      if (price < baseFee + tip || effectivePrice(baseFee) < minimumGasPrice) throw new Error('Gas price exceeds the signed cap.')
      const budget = gasLimit * price
      phase = 'reserve'
      if (budget > this.config.maxTransactionCost || balance < budget + this.config.reserve)
        throw new Error('Operator gas reserve is insufficient.')
      const transaction = { ...populated, gasLimit }
      phase = 'trace'
      const trace: unknown = await this.provider.send('debug_traceCall', [this.provider.getRpcTransaction(transaction),
        `0x${block.number.toString(16)}`, { tracer: 'callTracer', timeout: '10s' }])
      const privateCalldata = PROXY.encodeFunctionData('transact', [parsed.transactions])
      assertPrivateExecution(trace, privateCalldata)
      phase = 'fee'
      if (!secured) validateFee(this.store, parsed.feesID, payment, budget, await this.oracle.rates())
      phase = 'proof'
      const proof = secured ? await this.sdk.validatePrepaid!(parsed) : await this.sdk.validate(parsed)
      // Recheck fee/reserve state after commitment authentication without mutating the user's batch.
      phase = 'state'
      const fresh = await this.state()
      if (this.store.hasPending() || fresh.nonce !== nonce || fresh.confirmed !== nonce || fresh.balance < budget + this.config.reserve ||
        price < fresh.baseFee + tip || effectivePrice(fresh.baseFee) < fresh.minimumGasPrice) throw new Error('Execution state changed during validation.')
      phase = 'network'
      await this.validateNetworkAndAuthority(parsed, fresh.block.number)
      phase = 'trace'
      if (fresh.block.hash !== block.hash) assertPrivateExecution(await this.provider.send('debug_traceCall', [
        this.provider.getRpcTransaction(transaction), `0x${fresh.block.number.toString(16)}`, { tracer: 'callTracer', timeout: '10s' },
      ]), privateCalldata)
      phase = 'fee'
      if (!secured) validateFee(this.store, parsed.feesID, payment, budget, await this.oracle.rates())
      else {
        secured.backing = await (await this.credits()).assertBacked(secured.maximumCharge)
        if (secured.expiration <= Date.now()) throw new Error('Prepaid quote expired before signing.')
      }
      phase = 'sign'
      if (Math.abs(Date.now() / 1000 - fresh.block.timestamp) > 45) throw new Error('The validated head expired before signing.')
      if (this.store.exposure() + budget > this.config.dailyBudget) throw new Error('Operator gas budget exhausted.')
      this.lastRequests.push(performance.now())
      if (secured) (await this.credits()).ledger.reserve({ key: request.key, envelope: request.envelope,
        unsigned: Transaction.from({ ...transaction, from: undefined }).unsignedSerialized, nonce, gasBudget: budget,
        dailyBudget: this.config.dailyBudget, withdrawalPilot: this.config.admission === 'pilot' && (!parsed.type4 || !!parsed.withdrawal),
        prepaidPilotLedgerId: this.config.prepaidPilotLedgerId, ...secured })
      const raw = await signApprovedTransaction(this.wallet, transaction)
      const hash = Transaction.from(raw).hash!
      if (secured) (await this.credits()).ledger.attachSignature(request.key, raw)
      else {
        const [feeToken, feeAmount] = Object.entries(payment)[0]
        this.store.signed(request.key, request.envelope, raw, hash, budget, this.config.dailyBudget,
          nonce, JSON.stringify({ ...proof, payment: { token: feeToken, amount: feeAmount.toString() } }),
          feeQuote.expiration, this.config.admission === 'pilot' && (!parsed.type4 || !!parsed.withdrawal))
      }
      phase = 'submit'
      const sent = await this.sender.broadcastTransaction(raw, feeQuote.expiration)
      if (sent.hash !== hash) throw new Error('Unexpected protected transaction hash.')
      const encrypted = reply({ txHash: hash, ...(secured?.nativeReserve !== undefined ? { nonce } : {}) })
      this.store.respond(request.key, encrypted)
      return responseEnvelope(encrypted, request.id)
    } catch {
      console.error(JSON.stringify({ status: 'request-rejected', phase }))
      const unknown = this.store.get(request.key)
      const errors: Record<string, string> = {
        prepaid: 'Prepaid request rejected. Check the confirmed balance and refresh the quote; retain any saved attempt.',
        request: 'Broadcaster is unavailable or the request is unsupported. Check recovery before preparing another request.',
        busy: 'The broadcaster is finishing another transaction or checking its fee. Keep the saved proof and retry when the broadcaster is available.',
        admission: 'The broadcaster request limit was reached. Keep the saved proof and retry later.',
        format: 'The broadcaster rejected the request format. Keep the saved withdrawal and use Retry saved withdrawal through broadcaster.',
        pilot: 'The swap account is outside this restricted pilot. Keep the saved transaction.',
        'withdrawal-recipient': this.config.admission === 'pilot'
          ? 'The withdrawal destination does not match the approved pilot recipient. Keep the saved withdrawal.'
          : 'The withdrawal destination must be a nonzero public address. Keep the saved withdrawal.',
        'withdrawal-token': this.config.admission === 'pilot'
          ? 'This pilot permits a positive USDC withdrawal only. Keep the saved withdrawal.'
          : `A withdrawal requires a positive amount of a supported ${CHAIN_ID === 56 ? 'withdrawal' : 'fee'} token. Keep the saved withdrawal.`,
        'withdrawal-used': 'The one-time withdrawal pilot is already used. Check the pending withdrawal before retrying.',
        'withdrawal-fee': CHAIN_ID === 56 ? 'The withdrawal fee must be paid in WBNB. Keep the saved withdrawal.'
          : 'The withdrawal fee must be paid in the withdrawn token. Keep the saved withdrawal.',
        'bound-withdrawal-fee': `The withdrawal fee must be paid in ${TOKENS[0].symbol}. Keep the saved withdrawal.`,
        simulation: 'The private transaction did not pass execution simulation. Check recovery before retrying.',
        network: 'The broadcaster could not verify the current privacy contracts. Keep the saved withdrawal.',
        pricing: 'Current gas pricing exceeds the permitted limits. Keep the saved proof and retry through the broadcaster later.',
        estimate: 'The network rejected the saved transaction during gas estimation. Keep the saved proof.',
        allowance: 'Estimated gas exceeds the permitted transaction allowance. Keep the saved proof.',
        reserve: 'The transaction exceeds the operator gas budget or protected reserve. Keep the saved proof.',
        trace: 'The saved transaction failed its exact execution trace. Keep the saved proof.',
        state: 'Execution conditions changed during validation. Keep the saved proof and retry through the broadcaster.',
        fee: 'The broadcaster fee quote expired or does not cover execution. Check recovery before preparing another quote.',
        proof: 'The private fee commitment could not be authenticated.',
        sign: 'Operator signing or spending limits prevented execution.',
      }
      const encrypted = reply({ error: unknown
        ? 'Submission outcome is unknown. The signed transaction is retained; check recovery before retrying.'
        : errors[phase] ?? 'Protected submission failed.' })
      if (unknown) this.store.respond(request.key, encrypted)
      return responseEnvelope(encrypted, request.id)
    } finally { if (reserved) { this.busy = false; this.activeKey = undefined } }
  }

  private async nativeRefund(credits: CreditService, request: CreditRequest, envelope: string): Promise<Record<string, unknown>> {
    if (this.busy || this.store.hasPending() || !this.sdk.ready()) throw new Error('Resolve the preceding operator request first.')
    assertSigningNetwork(this.config)
    this.busy = true; this.activeKey = request.key
    try {
      const secured = await credits.secureNativeRefund(request)
      const initial = await this.state()
      const tip = initial.minimumGasPrice > initial.baseFee ? initial.minimumGasPrice - initial.baseFee : 1n
      const price = initial.baseFee * 2n + tip
      if (initial.nonce !== initial.confirmed || this.store.nonceBlocked(initial.nonce) || price < initial.baseFee + tip ||
        price * 5n > this.config.maxGasPrice * 4n)
        throw new Error('Native refund nonce or gas pricing is unavailable.')
      const transaction = { to: secured.recipient, value: secured.net, data: '0x', type: 2, chainId: CHAIN,
        nonce: initial.nonce, maxFeePerGas: price, maxPriorityFeePerGas: tip }
      const estimate = await this.provider.estimateGas({ ...transaction, from: this.wallet.address })
      if (typeof estimate !== 'bigint' || estimate < 21_000n) throw new Error('Invalid native refund gas estimate.')
      const gasLimit = ceilDiv(estimate * 110n, 100n), budget = gasLimit * price
      if (gasLimit > MAX_GAS || budget > this.config.maxTransactionCost ||
        initial.balance < secured.net + budget + this.config.reserve)
        throw new Error('Native refund exceeds the approved gas or balance limit.')
      const populated = { ...transaction, gasLimit }
      const trace = async (block: number) => assertNativeRefundTrace(await this.provider.send('debug_traceCall', [
        this.provider.getRpcTransaction({ ...populated, from: this.wallet.address }),
        `0x${block.toString(16)}`, { tracer: 'callTracer', timeout: '10s' },
      ]), { from: this.wallet.address, to: secured.recipient, value: secured.net })
      await trace(initial.block.number)
      secured.backing = await credits.assertBacked(secured.maximumCharge)
      const fresh = await this.state()
      const effectivePrice = fresh.baseFee + tip < price ? fresh.baseFee + tip : price
      if (this.store.hasPending() || fresh.nonce !== initial.nonce || fresh.confirmed !== initial.nonce ||
        fresh.balance < secured.net + budget + this.config.reserve || price < fresh.baseFee + tip ||
        effectivePrice < fresh.minimumGasPrice || secured.expiration <= Date.now() ||
        Math.abs(Date.now() / 1000 - fresh.block.timestamp) > 45 || this.store.exposure() + budget > this.config.dailyBudget)
        throw new Error('Native refund execution conditions changed.')
      if (fresh.block.hash !== initial.block.hash) await trace(fresh.block.number)
      // The user's net refund and worst-case gas are held atomically with the operator nonce before any signature.
      credits.ledger.reserve({ key: request.key, envelope,
        unsigned: Transaction.from(populated).unsignedSerialized, nonce: initial.nonce, gasBudget: budget,
        dailyBudget: this.config.dailyBudget, ...secured, nativeRefund: { recipient: secured.recipient, net: secured.net } })
      const raw = await signApprovedTransaction(this.wallet, populated)
      credits.ledger.attachSignature(request.key, raw)
      const hash = Transaction.from(raw).hash!
      const sent = await this.sender.broadcastTransaction(raw, secured.expiration)
      if (sent.hash !== hash) throw new Error('Unexpected protected native refund hash.')
      return credits.read(request)
    } finally { this.busy = false; this.activeKey = undefined }
  }

  private async validateNetworkAndAuthority(request: ParsedRequest, blockTag: number): Promise<void> {
    if (request.withdrawal) {
      const result = await this.provider.call({ to: NETWORK.proxyContract, data: PROXY.encodeFunctionData('unshieldFee'), blockTag })
      const fee = BigInt(PROXY.decodeFunctionResult('unshieldFee', result)[0])
      if (fee < 0n || fee > 5000n || request.withdrawal.amount !== request.withdrawal.grossAmount - request.withdrawal.grossAmount * fee / 10_000n)
        throw new Error('The signed withdrawal transfer does not match its current net unshield amount.')
    }
    if (this.config.executionGuard) {
      const [code, delegateCode] = await Promise.all([
        this.provider.getCode(this.config.executionGuard, blockTag),
        this.provider.getCode(NETWORK.relayAdapt7702Contract, blockTag),
      ])
      assertExecutionGuardCode(this.wallet.address, code, delegateCode, NETWORK.relayAdapt7702Contract)
    }
    if (request.withdrawal && !/^0x(?:[0-9a-f]{2})+$/i.test(await this.provider.getCode(request.withdrawal.token, blockTag)))
      throw new Error('The withdrawal principal must be a token contract.')
    const registered = await this.provider.call({ to: NETWORK.railgunRegistryContract,
      data: REGISTRY.encodeFunctionData('getContractAddress', ['RelayAdapt7702']), blockTag })
    if (getAddress(REGISTRY.decodeFunctionResult('getContractAddress', registered)[0]) !== getAddress(NETWORK.relayAdapt7702Contract))
      throw new Error('The canonical privacy delegate changed.')
    if (request.authorization) {
      const to = String(request.transaction.to)
      if (BigInt(await this.provider.getTransactionCount(to, blockTag)) !== request.authorization.nonce)
        throw new Error('The private authorization nonce changed.')
      const probe = { ...request.transaction, from: this.wallet.address,
        data: ADAPT.encodeFunctionData('adaptImplementation'), blockTag }
      const implementation = ADAPT.decodeFunctionResult('adaptImplementation', await this.provider.call(probe))[0]
      if (getAddress(implementation) !== getAddress(NETWORK.relayAdapt7702Contract)) throw new Error('Delegation simulation is unsupported.')
      const result = await this.provider.call({ ...probe, data: ADAPT.encodeFunctionData('nonce') })
      if (BigInt(ADAPT.decodeFunctionResult('nonce', result)[0]) !== request.executeNonce)
        throw new Error('The private execution nonce changed.')
    }
  }

  async reconcile(): Promise<void> {
    const { block: head, confirmed, settled } = await this.state()
    if (this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_identity'").get())
      await (await this.credits()).reconcileRefunds()
    for (const item of this.store.pending()) {
      if (!item.hash) continue
      this.store.checked(item.key)
      try {
      if (JSON.parse(item.fee_data).kind === 'prepaid') {
        const credits = await this.credits()
        let included = false
        for (const hash of [item.hash, ...this.store.cancellations(item.key).map((tx) => tx.hash)]) {
          const receipt = await this.provider.getTransactionReceipt(hash)
          if (!receipt || receipt.blockNumber > settled || (await this.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) continue
          included = true
          credits.ledger.observeInclusion(item.key, receipt)
          const finalized = await finalizedCreditReceipt(this.provider, hash)
          credits.ledger.settle(item.key, finalized)
          break
        }
        if (!included && item.confirmed && confirmed <= item.nonce) credits.ledger.forgetInclusion(item.key)
        continue
      }
      const original = await this.provider.getTransactionReceipt(item.hash)
      let receipt = original
      if (!receipt) for (const cancellation of this.store.cancellations(item.key)) {
        const candidate = await this.provider.getTransactionReceipt(cancellation.hash)
        if (!candidate || candidate.blockNumber > settled) continue
        const block = await this.provider.getBlock(candidate.blockNumber)
        if (block?.hash === candidate.blockHash) { receipt = candidate; break }
      }
      if (!receipt) {
        if (!item.confirmed && confirmed > item.nonce) {
          // An unidentified nonce consumption never proves fee delivery.
          this.store.confirmed(item.key, BigInt(item.max_cost), head.timestamp * 1000)
        }
        continue
      }
      if (receipt.blockNumber > settled) continue
      {
        const block = await this.provider.getBlock(receipt.blockNumber)
        if (!block || block.hash !== receipt.blockHash) continue
        this.store.confirmed(item.key, receipt.gasUsed * receipt.gasPrice, block.timestamp * 1000)
      }
      if (!original) { this.store.assured(item.key); continue }
      const request = await openRequest(Buffer.from(item.envelope), this.sdk.privateViewingKey, this.sdk.publicViewingKey)
      if (request) this.store.respond(item.key, encryptResponse({ txHash: item.hash }, request))
      if (receipt.status === 1 && !item.assured &&
        await this.sdk.assure(item.hash, JSON.parse(item.fee_data) as FeeProof)) this.store.assured(item.key, true)
      // An included sponsored revert paid no fee: retain the halt for operator review.
      } catch { /* Retain each failed assurance and continue with other requests. */ }
    }
  }
}
