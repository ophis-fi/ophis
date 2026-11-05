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

const REGISTRY = new Interface(['function getContractAddress(string name) view returns (address)'])
type SDK = Pick<RailgunSDK, 'address' | 'privateViewingKey' | 'publicViewingKey' | 'ready' | 'sign' | 'fee' | 'validate' | 'assure'>
type Sender = { broadcastTransaction(raw: string, validUntilMs?: number): Promise<Pick<TransactionResponse, 'hash'>> }

export class Broadcaster {
  // shortcut: one gas wallet; add independently journaled senders when measured demand needs concurrency.
  private busy = false
  private activeKey?: string
  private lastRequests: number[] = []
  private attempts: number[] = []
  constructor(
    readonly config: Settings, readonly store: Store, private readonly sdk: SDK,
    readonly provider: JsonRpcProvider, readonly wallet: GasSigner, private readonly sender: Sender,
    private readonly oracle: Pick<FeeOracle, 'rates'>,
  ) {}

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
    if (this.config.admission === 'pilot' && this.config.pilotWithdrawalRecipient &&
      this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get('withdrawalPilot')) return false
    const { nonce, confirmed, balance, minimumGasPrice } = await this.state()
    return minimumGasPrice <= this.config.maxGasPrice && nonce === confirmed &&
      balance >= this.config.reserve + this.config.maxTransactionCost &&
      this.store.exposure() < this.config.dailyBudget &&
      !this.store.nonceBlocked(confirmed)
  }

  async feeAdvertisement(): Promise<Uint8Array> {
    const available = await this.available()
    const quote = issueFee(this.store, await this.oracle.rates())
    const data = fromUTF8String(JSON.stringify({
      fees: Object.fromEntries(Object.entries(quote.rates).map(([token, rate]) => [token.toLowerCase(), rate])),
      feeExpiration: quote.expiration, feesID: quote.id, railgunAddress: this.sdk.address,
      identifier: `ophis-${CHAIN_ID}`, availableWallets: available ? 1 : 0, version: BROADCASTER_VERSION,
      relayAdapt: NETWORK.relayAdaptContract, relayAdapt7702: NETWORK.relayAdapt7702Contract,
      requiredPOIListKeys: [], reliability: 0.75,
    }))
    return Buffer.from(JSON.stringify({ data, signature: await this.sdk.sign(data) }))
  }

  async handle(payload: Uint8Array): Promise<Uint8Array | undefined> {
    const request = await openRequest(payload, this.sdk.privateViewingKey, this.sdk.publicViewingKey)
    if (!request) return
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
      const parsed = parseRequest(request.data, this.wallet.address, this.config)
      phase = 'pilot'
      if (parsed.type4 && this.config.admission === 'pilot' && this.config.pilotAccount &&
        getAddress(String(parsed.transaction.to)) !== this.config.pilotAccount)
        throw new Error('This operator is restricted to its selected pilot account.')
      let withdrawalToken: string | undefined
      if (!parsed.type4) {
        const withdrawal = parsed.transactions[0].unshieldPreimage
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
          !TOKENS.some((token) => getAddress(token.address) === withdrawalToken) ||
          (this.config.admission === 'pilot' && withdrawalToken !== getAddress(TOKENS[1].address)) ||
          BigInt(withdrawal.value) <= 0n) throw new Error('Wrong withdrawal token.')
        phase = 'withdrawal-used'
        if (this.config.admission === 'pilot' && this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get('withdrawalPilot'))
          throw new Error('Withdrawal pilot used.')
      }
      const feeQuote = this.store.db.prepare('SELECT expiration FROM fees WHERE id=?').get(parsed.feesID) as { expiration: number } | undefined
      if (!feeQuote || feeQuote.expiration <= Date.now()) { phase = 'fee'; throw new Error('Fee quote expired.') }
      this.busy = true; this.activeKey = request.key; reserved = true
      phase = 'fee'
      const payment = await this.sdk.fee(parsed)
      if (withdrawalToken && (Object.keys(payment).length !== 1 || !payment[withdrawalToken])) {
        phase = 'withdrawal-fee'
        throw new Error('The withdrawal broadcaster fee must use the withdrawn token.')
      }
      validateFee(this.store, parsed.feesID, payment, 1n, await this.oracle.rates())
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
      validateFee(this.store, parsed.feesID, payment, budget, await this.oracle.rates())
      phase = 'proof'
      const proof = await this.sdk.validate(parsed)
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
      validateFee(this.store, parsed.feesID, payment, budget, await this.oracle.rates())
      phase = 'sign'
      if (Math.abs(Date.now() / 1000 - fresh.block.timestamp) > 45) throw new Error('The validated head expired before signing.')
      if (this.store.exposure() + budget > this.config.dailyBudget) throw new Error('Operator gas budget exhausted.')
      this.lastRequests.push(performance.now())
      const raw = await signApprovedTransaction(this.wallet, transaction)
      const hash = Transaction.from(raw).hash!
      const [feeToken, feeAmount] = Object.entries(payment)[0]
      this.store.signed(request.key, request.envelope, raw, hash, budget, this.config.dailyBudget,
        nonce, JSON.stringify({ ...proof, payment: { token: feeToken, amount: feeAmount.toString() } }),
        feeQuote.expiration, this.config.admission === 'pilot' && !parsed.type4)
      phase = 'submit'
      const sent = await this.sender.broadcastTransaction(raw, feeQuote.expiration)
      if (sent.hash !== hash) throw new Error('Unexpected protected transaction hash.')
      const encrypted = encryptResponse({ txHash: hash }, request)
      this.store.respond(request.key, encrypted)
      return responseEnvelope(encrypted, request.id)
    } catch {
      console.error(JSON.stringify({ status: 'request-rejected', phase }))
      const unknown = this.store.get(request.key)?.raw
      const errors: Record<string, string> = {
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
          : 'A withdrawal requires a positive amount of a supported fee token. Keep the saved withdrawal.',
        'withdrawal-used': 'The one-time withdrawal pilot is already used. Check the pending withdrawal before retrying.',
        'withdrawal-fee': 'The withdrawal fee must be paid in the withdrawn token. Keep the saved withdrawal.',
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
      const encrypted = encryptResponse({ error: unknown
        ? 'Submission outcome is unknown. The signed transaction is retained; check recovery before retrying.'
        : errors[phase] ?? 'Protected submission failed.' }, request)
      if (unknown) this.store.respond(request.key, encrypted)
      return responseEnvelope(encrypted, request.id)
    } finally { if (reserved) { this.busy = false; this.activeKey = undefined } }
  }

  private async validateNetworkAndAuthority(request: ParsedRequest, blockTag: number): Promise<void> {
    if (this.config.executionGuard) {
      const [code, delegateCode] = await Promise.all([
        this.provider.getCode(this.config.executionGuard, blockTag),
        this.provider.getCode(NETWORK.relayAdapt7702Contract, blockTag),
      ])
      assertExecutionGuardCode(this.wallet.address, code, delegateCode, NETWORK.relayAdapt7702Contract)
    }
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
    for (const item of this.store.pending()) {
      if (!item.hash) continue
      this.store.checked(item.key)
      try {
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
