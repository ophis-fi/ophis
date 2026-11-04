import { fromUTF8String } from '@railgun-community/wallet'
import { getAddress, Interface, JsonRpcProvider, Transaction, type TransactionResponse } from 'ethers'
import { BROADCASTER_VERSION, MAX_GAS, NETWORK, TOKENS, VERSION, type Settings } from './config'
import { issueFee, validateFee, ceilDiv } from './fees'
import { Store } from './storage'
import { ADAPT, PROXY, assertPrivateExecution, parseRequest, type ParsedRequest } from './transaction'
import { encryptResponse, openRequest, responseEnvelope } from './wire'
import type { FeeOracle } from './fees'
import type { RailgunSDK, FeeProof } from './sdk'
import { assertExecutionGuardCode, guardedExecution } from '../../railgun/operator/execution-guard'
import { signApprovedTransaction, type GasSigner } from './signer'

const REGISTRY = new Interface(['function getContractAddress(string name) view returns (address)'])
type SDK = Pick<RailgunSDK, 'address' | 'privateViewingKey' | 'publicViewingKey' | 'ready' | 'sign' | 'fee' | 'validate' | 'assure'>
type Sender = { broadcastTransaction(raw: string): Promise<Pick<TransactionResponse, 'hash'>> }

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
    if ((await this.provider.getNetwork()).chainId !== 1n) throw new Error('Wrong Ethereum read node.')
    const block = await this.provider.getBlock('latest')
    if (!block || block.baseFeePerGas == null || Math.abs(Date.now() / 1000 - block.timestamp) > 45)
      throw new Error('Ethereum read node is stale.')
    const [nonce, confirmed, balance] = await Promise.all([
      this.provider.getTransactionCount(this.wallet.address, block.number),
      this.provider.getTransactionCount(this.wallet.address, Math.max(0, block.number - 1)),
      this.provider.getBalance(this.wallet.address, block.number),
    ])
    return { block, nonce, confirmed, balance }
  }

  async available(): Promise<boolean> {
    if (!this.config.enabled || this.busy || !this.sdk.ready()) return false
    if (this.config.pilotWithdrawalRecipient && this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get('withdrawalPilot')) return false
    const { nonce, confirmed, balance, block } = await this.state()
    return block.baseFeePerGas! + 1n <= this.config.maxGasPrice && nonce === confirmed &&
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
      identifier: 'ophis-ethereum', availableWallets: available ? 1 : 0, version: BROADCASTER_VERSION,
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
      if (!this.config.enabled || this.busy || !this.sdk.ready()) throw new Error('Broadcaster not available.')
      const now = performance.now()
      this.lastRequests = this.lastRequests.filter((time) => now - time < 60_000)
      this.attempts = this.attempts.filter((time) => now - time < 60_000)
      if (this.attempts.length >= 300) throw new Error('Broadcaster admission limit reached.')
      this.attempts.push(now)
      if (this.lastRequests.length >= 30) throw new Error('Broadcaster request limit reached.')
      phase = 'format'
      const parsed = parseRequest(request.data, this.wallet.address, this.config)
      phase = 'pilot'
      if (parsed.type4 && this.config.pilotAccount && getAddress(String(parsed.transaction.to)) !== this.config.pilotAccount)
        throw new Error('This operator is restricted to its selected pilot account.')
      if (!parsed.type4) {
        const withdrawal = parsed.transactions[0].unshieldPreimage
        phase = 'withdrawal-recipient'
        if (!this.config.pilotWithdrawalRecipient || typeof withdrawal.npk !== 'string' ||
          BigInt(withdrawal.npk) !== BigInt(this.config.pilotWithdrawalRecipient)) throw new Error('Wrong withdrawal recipient.')
        phase = 'withdrawal-token'
        if (typeof withdrawal.token.tokenAddress !== 'string' || BigInt(withdrawal.token.tokenType) !== 0n ||
          BigInt(withdrawal.token.tokenSubID) !== 0n || getAddress(withdrawal.token.tokenAddress) !== getAddress(TOKENS[1].address) ||
          BigInt(withdrawal.value) <= 0n) throw new Error('Wrong withdrawal token.')
        phase = 'withdrawal-used'
        if (this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get('withdrawalPilot')) throw new Error('Withdrawal pilot used.')
      }
      const feeQuote = this.store.db.prepare('SELECT expiration FROM fees WHERE id=?').get(parsed.feesID) as { expiration: number } | undefined
      if (!feeQuote || feeQuote.expiration <= Date.now()) { phase = 'fee'; throw new Error('Fee quote expired.') }
      this.busy = true; this.activeKey = request.key; reserved = true
      phase = 'fee'
      const payment = await this.sdk.fee(parsed)
      if (!parsed.type4 && (Object.keys(payment).length !== 1 || !payment[getAddress(TOKENS[1].address)]))
        throw new Error('The withdrawal broadcaster fee must be paid in USDC.')
      validateFee(this.store, parsed.feesID, payment, 1n, await this.oracle.rates())
      const { nonce, confirmed, balance, block } = await this.state()
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
        if (block.baseFeePerGas! + 1n > gasPrice) gasPrice = block.baseFeePerGas! + 1n
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
      phase = 'pricing'
      if (price < block.baseFeePerGas! + tip) throw new Error('Gas price exceeds the signed cap.')
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
      if (fresh.nonce !== nonce || fresh.confirmed !== nonce || fresh.balance < budget + this.config.reserve ||
        price < fresh.block.baseFeePerGas! + tip) throw new Error('Execution state changed during validation.')
      phase = 'network'
      await this.validateNetworkAndAuthority(parsed, fresh.block.number)
      phase = 'trace'
      if (fresh.block.number !== block.number) assertPrivateExecution(await this.provider.send('debug_traceCall', [
        this.provider.getRpcTransaction(transaction), `0x${fresh.block.number.toString(16)}`, { tracer: 'callTracer', timeout: '10s' },
      ]), privateCalldata)
      phase = 'fee'
      validateFee(this.store, parsed.feesID, payment, budget, await this.oracle.rates())
      phase = 'sign'
      if (this.store.exposure() + budget > this.config.dailyBudget) throw new Error('Operator gas budget exhausted.')
      this.lastRequests.push(performance.now())
      const raw = await signApprovedTransaction(this.wallet, transaction)
      const hash = Transaction.from(raw).hash!
      this.store.signed(request.key, request.envelope, raw, hash, budget, this.config.dailyBudget,
        nonce, JSON.stringify(proof), feeQuote.expiration, !parsed.type4)
      phase = 'submit'
      const sent = await this.sender.broadcastTransaction(raw)
      if (sent.hash !== hash) throw new Error('Unexpected protected transaction hash.')
      const encrypted = encryptResponse({ txHash: hash }, request)
      this.store.respond(request.key, encrypted)
      return responseEnvelope(encrypted, request.id)
    } catch {
      console.error(JSON.stringify({ status: 'request-rejected', phase }))
      const unknown = this.store.get(request.key)?.raw
      const errors: Record<string, string> = {
        request: 'Broadcaster is unavailable or the request is unsupported. Check recovery before preparing another request.',
        format: 'The broadcaster rejected the request format. Keep the saved withdrawal and use Retry saved withdrawal through broadcaster.',
        pilot: 'The swap account is outside this restricted pilot. Keep the saved transaction.',
        'withdrawal-recipient': 'The withdrawal destination does not match the approved pilot recipient. Keep the saved withdrawal.',
        'withdrawal-token': 'This pilot permits a positive USDC withdrawal only. Keep the saved withdrawal.',
        'withdrawal-used': 'The one-time withdrawal pilot is already used. Check the pending withdrawal before retrying.',
        simulation: 'The private transaction did not pass execution simulation. Check recovery before retrying.',
        network: 'The broadcaster could not verify the current Ethereum privacy contracts. Keep the saved withdrawal.',
        pricing: 'Current gas pricing exceeds the permitted limits. Keep the saved proof and retry through the broadcaster later.',
        estimate: 'Ethereum rejected the saved transaction during gas estimation. Keep the saved proof.',
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
    if (request.type4 && this.config.executionGuard) {
      const [code, delegateCode] = await Promise.all([
        this.provider.getCode(this.config.executionGuard, blockTag),
        this.provider.getCode(NETWORK.relayAdapt7702Contract, blockTag),
      ])
      assertExecutionGuardCode(this.wallet.address, code, delegateCode)
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
    const blockNumber = await this.provider.getBlockNumber()
    for (const item of this.store.pending()) {
      if (!item.hash) continue
      this.store.checked(item.key)
      try {
      const original = await this.provider.getTransactionReceipt(item.hash)
      const receipt = original ?? (item.cancel_hash ? await this.provider.getTransactionReceipt(item.cancel_hash) : null)
      if (!receipt) {
        const confirmed = await this.provider.getTransactionCount(this.wallet.address, Math.max(0, blockNumber - 1))
        if (confirmed > item.nonce) {
          const block = await this.provider.getBlock(blockNumber)
          if (block) {
            // Only the operator nonce is consumed; the user's proof/recovery state is not cleared.
            this.store.confirmed(item.key, BigInt(item.max_cost), block.timestamp * 1000)
          }
        }
        if (!item.confirmed) continue
        if (!item.assured && await this.sdk.assure(item.hash, JSON.parse(item.fee_data) as FeeProof))
          this.store.assured(item.key)
        continue
      }
      if (blockNumber - receipt.blockNumber + 1 < 2) continue
      {
        const block = await this.provider.getBlock(receipt.blockNumber)
        if (!block) continue
        this.store.confirmed(item.key, receipt.gasUsed * receipt.gasPrice, block.timestamp * 1000)
      }
      if (!original) { this.store.assured(item.key); continue }
      const request = await openRequest(Buffer.from(item.envelope), this.sdk.privateViewingKey, this.sdk.publicViewingKey)
      if (request) this.store.respond(item.key, encryptResponse({ txHash: item.hash }, request))
      if (receipt.status === 1 && !item.assured &&
        await this.sdk.assure(item.hash, JSON.parse(item.fee_data) as FeeProof)) this.store.assured(item.key)
      if (receipt.status !== 1) this.store.assured(item.key)
      } catch { /* Retain each failed assurance and continue with other requests. */ }
    }
  }
}
