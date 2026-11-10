import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as ed from '@noble/ed25519'
import { encryptDataWithSharedKey, tryDecryptJSONDataWithSharedKey } from '@railgun-community/wallet'
import { getAddress, id, Interface, JsonRpcProvider, Transaction, Wallet, ZeroAddress, type TransactionReceipt } from 'ethers'
import { Broadcaster } from '../src/broadcaster'
import { Store } from '../src/storage'
import { accountingReport } from '../src/operations'
import { issueFee } from '../src/fees'
import { ADAPT, PROXY } from '../src/transaction'
import { CHAIN, CHAIN_ID, COMMON_TRANSACTION_TYPE, FEE_TOKENS, NETWORK, TOKENS } from '../src/config'
import { config, privateRequest, signedNativeWithdrawalRequest, signedWithdrawalRequest, withdrawalRequest } from './request.fixture'
import { decodeGuardedExecution, executionGuardCode } from '../../railgun/operator/execution-guard'
import { CreditLedger } from '../src/credit'
import { ANON_COLLECTION_ABI, ANON_COLLECTION_GATEWAY } from '../src/anon-native-collection'
const anonRuntime = readFileSync(new URL('./fixtures/anon-gateway-runtime.hex', import.meta.url), 'utf8').trim()
import { verifyCreditBacking, type CreditBacking } from '../src/credit-backing'
import type { AccountedNote } from '../src/credit-owner-payment'
import { chainFixture, syntheticNote, provenance } from './credit-owner.fixture'
import { CREDIT_PROTOCOL, CREDIT_AUTHORIZATION_TYPES, CREDIT_MAX_PAYLOAD, creditAuthorizationValue, creditDomain, nativeCreditData, creditRequestKey, creditRequestKeyFromPayloadHash } from '../../railgun/credit-protocol'

const registry = new Interface(['function getContractAddress(string name) view returns (address)'])
const blockHash = `0x${'55'.repeat(32)}`
let directory: string, store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ophis-broadcaster-gates-')); store = new Store(directory) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

async function packetFor(data: Record<string, unknown>, publicViewingKey: string) {
  const encrypted = await encryptDataWithSharedKey(data, Buffer.from(publicViewingKey, 'hex'))
  const packet = { method: 'transact', id: 1, params: { pubkey: encrypted.randomPubKey, encryptedData: encrypted.encryptedData } }
  const payload = Buffer.from(JSON.stringify(packet))
  const decode = (response: Uint8Array | undefined) => {
    expect(response).toBeDefined()
    return tryDecryptJSONDataWithSharedKey(JSON.parse(Buffer.from(response!).toString()).result, encrypted.sharedKey) as Record<string, any>
  }
  return { packet, payload, decode }
}

function privateCalldata(data: Record<string, unknown>): string {
  return data.transactType === 'COMMON' ? String(data.data) : PROXY.encodeFunctionData('transact', [
    ADAPT.decodeFunctionData('execute', String(data.data))._transactions,
  ])
}

async function fixture(guard?: string, withdrawalRecipient?: string, commonWithdrawal = false) {
  if (CHAIN_ID === 56 && withdrawalRecipient && !commonWithdrawal) guard ??= Wallet.createRandom().address
  const privateViewingKey = randomBytes(32), publicViewingKey = Buffer.from(await ed.getPublicKey(privateViewingKey)).toString('hex')
  const wallet = new Wallet(Wallet.createRandom().privateKey)
  store.bindIdentity(CHAIN_ID, wallet.address)
  const rates = Object.fromEntries(FEE_TOKENS.map((token, index) => [token.address, index === 0 ? 10n ** 18n : 2_000_000_000n]))
  const quote = issueFee(store, rates)
  const data = withdrawalRecipient ? CHAIN_ID === 56 && !commonWithdrawal
    ? await signedWithdrawalRequest(quote.id, publicViewingKey, withdrawalRecipient)
    : await withdrawalRequest(quote.id, publicViewingKey, withdrawalRecipient, 1, 1, TOKENS[CHAIN_ID === 56 ? 0 : 1].address)
    : await privateRequest(quote.id, publicViewingKey)
  const wire = await packetFor(data, publicViewingKey)
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: CHAIN })),
    getFeeData: vi.fn(async () => ({ gasPrice: 2n, maxPriorityFeePerGas: 1n })),
    getBlock: vi.fn(async (_tag?: number | string) => ({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n })),
    getTransactionCount: vi.fn(async () => 0), getBalance: vi.fn(async () => 10n ** 18n),
    getBlockNumber: vi.fn(async () => 100),
    getTransactionReceipt: vi.fn(async (_hash?: string): Promise<Pick<TransactionReceipt, 'status' | 'blockNumber' | 'blockHash' | 'gasUsed' | 'gasPrice'> | null> => null),
    estimateGas: vi.fn(async () => 100_000n),
    getCode: vi.fn(async (address: string, _tag?: string | number) => address.toLowerCase() === ANON_COLLECTION_GATEWAY.toLowerCase() ? anonRuntime : address === guard
      ? executionGuardCode(wallet.address, '0x6001', NETWORK.relayAdapt7702Contract) : '0x6001'),
    call: vi.fn(async (tx: { data: string }) => {
      if (tx.data === ANON_COLLECTION_ABI.encodeFunctionData('baseFeeBP'))
        return ANON_COLLECTION_ABI.encodeFunctionResult('baseFeeBP', [13n])
      if (tx.data === PROXY.encodeFunctionData('unshieldFee'))
        return PROXY.encodeFunctionResult('unshieldFee', [0n])
      if (tx.data.startsWith(registry.getFunction('getContractAddress')!.selector))
        return registry.encodeFunctionResult('getContractAddress', [NETWORK.relayAdapt7702Contract])
      if (tx.data === ADAPT.encodeFunctionData('adaptImplementation'))
        return ADAPT.encodeFunctionResult('adaptImplementation', [NETWORK.relayAdapt7702Contract])
      return ADAPT.encodeFunctionResult('nonce', [0n])
    }),
    getRpcTransaction: vi.fn((value) => value), send: vi.fn(async (): Promise<unknown> => ({ type: 'CALL', calls: [
      { type: 'CALL', to: NETWORK.proxyContract, input: privateCalldata(data) },
    ] })),
  }
  const sdk = { address: 'test-fee-identity', privateViewingKey, publicViewingKey, ready: () => true,
    sign: vi.fn(async () => 'signature'),
    fee: vi.fn(async () => withdrawalRecipient && CHAIN_ID !== 56 ? { [TOKENS[1].address]: 2_000_000n } : { [TOKENS[0].address]: 2_000_000_000_000_000n }),
    validate: vi.fn(async () => ({ railgunTxid: 'test-txid', utxoTreeIn: 0, commitment: 'test-commitment', notePublicKey: 'test-npk', pois: {} })),
    assure: vi.fn(async () => true),
    confirmedCredits: vi.fn(async (_provider: unknown, _scope: unknown, _ledgerId: string, _owner: string, _hash: string) => [] as any[]),
    confirmedRefund: vi.fn(async (): Promise<any> => { throw new Error('No finalized refund') }),
    accountedCreditBacking: vi.fn(async (_provider: JsonRpcProvider, _accounted: readonly AccountedNote[], _maximumInputs: number): Promise<CreditBacking> => { throw new Error('No backing fixture configured') }),
    confirmedOwnerCollection: vi.fn(async (): Promise<any> => { throw new Error('No finalized owner collection') }),
    validatePrepaid: vi.fn(async () => {}),
  }
  const sender = { broadcastTransaction: vi.fn(async (raw: string, _validUntilMs?: number) => ({ hash: Transaction.from(raw).hash! })) }
  const sign = vi.spyOn(wallet, 'signTransaction')
  const service = new Broadcaster({ ...config, executionGuard: guard,
    ...(commonWithdrawal ? { admission: 'public' as const } : {}), pilotWithdrawalRecipient: commonWithdrawal ? undefined : withdrawalRecipient },
    store, sdk, provider as unknown as JsonRpcProvider, wallet, sender,
    { rates: async () => rates })
  return { ...wire, data, quote, service, sdk, provider, sender, sign, rates, wallet }
}

it.runIf(![1, 56].includes(CHAIN_ID))('keeps prepaid funding unavailable on an unqualified chain', async () => {
  const f = await fixture(Wallet.createRandom().address)
  const wire = await packetFor({ protocol: CREDIT_PROTOCOL, kind: 'info', correlation: id('unsupported credit chain'),
    broadcasterViewingKey: f.sdk.publicViewingKey }, f.sdk.publicViewingKey)
  expect(wire.decode(await f.service.handle(wire.payload)).error).toBeTruthy()
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
})

describe.runIf([1, 56].includes(CHAIN_ID))('prepaid execution through the encrypted protocol', () => {
  const recovery = (original: Record<string, unknown>) => ({ kind: 'recover', payloadHash: id(JSON.stringify(original)), operation: original.kind, sequence: original.sequence })
  async function prepaidFixture(native = false) {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    if (native) f.service.config.creditPaymentMode = 'public-native'
    f.sdk.address = '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
    f.service.config.creditCollectionGas = 100_000n
    f.service.config.creditCollectionInputs = 2
    f.service.config.creditCollectionOutputs = 4
    f.service.config.creditCollectionProofs = 2
    if (native) {
      f.service.config.creditCollectionGas = 0n
      f.service.config.creditCollectionInputs = f.service.config.creditCollectionOutputs = f.service.config.creditCollectionProofs = 0
      f.provider.getBalance.mockResolvedValue(2n * 10n ** 18n)
      f.provider.getBlock.mockImplementation(async (tag) => ({ number: typeof tag === 'number' ? tag : 100,
        hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }))
      const code = f.provider.getCode.getMockImplementation()!
      f.provider.getCode.mockImplementation(async (address) => address === f.wallet.address ? '0x' : code(address))
    }
    const originalCall = f.provider.call.getMockImplementation()!
    f.provider.call.mockImplementation(async (tx) => tx.data === PROXY.encodeFunctionData('unshieldFee')
      ? PROXY.encodeFunctionResult('unshieldFee', [25n]) : originalCall(tx))
    const backingChain = chainFixture(), note = syntheticNote(10n ** 18n, 0)
    backingChain.add(note)
    const notes = [note]
    const addBacking = (incoming: typeof note) => { backingChain.add(incoming); notes.push(incoming) }
    const backing = () => verifyCreditBacking(backingChain.provider, notes, CreditLedger.load(store).accountedNotes(), 2)
    f.sdk.accountedCreditBacking.mockImplementation(backing)
    const wire = await packetFor({ protocol: CREDIT_PROTOCOL, kind: 'info', correlation: id('info'), broadcasterViewingKey: f.sdk.publicViewingKey }, f.sdk.publicViewingKey)
    const info = wire.decode(await f.service.handle(wire.payload))
    expect(info.error).toBeUndefined()
    expect(info.protocol).toBe(CREDIT_PROTOCOL)
    const owner = Wallet.createRandom()
    async function request(payload: Record<string, unknown>, requestOwner = owner) {
      const encoded = JSON.stringify(payload), expires = Date.now() + 240_000
      const signature = await requestOwner.signTypedData(creditDomain(info.scope, info.ledgerId), CREDIT_AUTHORIZATION_TYPES,
        creditAuthorizationValue(info.scope, requestOwner.address, encoded, expires))
      return packetFor({ protocol: CREDIT_PROTOCOL, correlation: id(encoded), broadcasterViewingKey: f.sdk.publicViewingKey,
        authorization: { owner: requestOwner.address, payload: encoded, expires, signature } }, f.sdk.publicViewingKey)
    }
    async function send(payload: Record<string, unknown>) {
      const wire = await request(payload)
      return wire.decode(await f.service.handle(wire.payload))
    }
    const quote = await send({ kind: 'quote' })
    expect(quote.kind).toBe('quote')
    const execution = { kind: 'execute', sequence: quote.nextSequence, request: { ...f.data, feesID: quote.feesID }, maximumCharge: quote.maximumCharge,
      collectionAllowance: quote.collectionAllowance }
    async function fund() {
      if (native) {
        const paymentId = id('native topup'), transactionHash = id('native funding'), payer = Wallet.createRandom().address
        const transaction = { hash: transactionHash, chainId: CHAIN, type: 2, authorizationList: [], to: f.wallet.address, from: payer,
          value: 10n ** 18n, data: nativeCreditData(info.scope, info.ledgerId, owner.address, paymentId), blockNumber: 100, blockHash }
        const receipt = { hash: transactionHash, from: payer, to: f.wallet.address, blockNumber: 100, blockHash, status: 1, gasUsed: 22000n, gasPrice: 1n }
        Object.assign(f.provider, { getTransaction: vi.fn(async () => transaction) })
        f.provider.getTransactionReceipt.mockImplementation(async (hash) => hash === transactionHash ? receipt : null)
        const code = f.provider.getCode.getMockImplementation()!
        f.provider.getCode.mockImplementation(async (address) => address === payer ? '0x' : code(address))
        expect((await send({ kind: 'claim', transactionHash, paymentId })).available).toBe((10n ** 18n).toString())
        return { transactionHash, paymentId, transaction, receipt }
      }
      f.sdk.confirmedCredits.mockResolvedValueOnce([{ ...provenance(note), owner: owner.address, amount: 10n ** 18n }])
      expect((await send({ kind: 'claim', transactionHash: id('funding') })).available).toBe((10n ** 18n).toString())
    }
    return { ...f, owner, info, quote, execution, request, send, fund, backing, addBacking }
  }
  it('uses explicit native funding and fee quotes without ANON fees, note collection or a pricing oracle', async () => {
    const f = await prepaidFixture(true)
    expect(f.info.scope).toMatchObject({ funding: 'native', token: ZeroAddress, recipient: f.wallet.address })
    expect(f.info).toMatchObject({ executionEnabled: true, funding: 'user-submitted-native-transfer', refund: 'operator-executed-native-transfer' })
    expect(f.quote).toMatchObject({ collectionAllowance: '0', refundGasAllowance: f.service.config.maxTransactionCost.toString(), rate: '1150000000000000000' })
    await f.fund()
    expect(f.sdk.confirmedCredits).not.toHaveBeenCalled()
    expect(f.sdk.accountedCreditBacking).not.toHaveBeenCalled()
    expect(f.provider.call).not.toHaveBeenCalled()
    const result = await f.send(f.execution)
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(result.nonce).toBe(0)
    const replay = await f.send(f.execution)
    expect(replay.nonce).toBe(0)
    const attemptStatus = await f.send({ kind: 'attempt', key: store.pending()[0].key })
    expect(attemptStatus.nonce).toBe(0)
    expect(f.sdk.validatePrepaid).toHaveBeenCalledOnce()
    expect(f.sdk.fee).not.toHaveBeenCalled()
    expect(f.sdk.confirmedOwnerCollection).not.toHaveBeenCalled()
    const saved = store.pending()[0], ledger = CreditLedger.load(store)
    expect(ledger.attempt(saved.key)?.collection_allowance).toBe('0')
  })
  it.each(['owner', 'global', 'busy'])('rejects new prepaid work before RPC reads when %s admission is exhausted', async (limit) => {
    const f = await prepaidFixture(true); await f.fund()
    const admission = f.service as unknown as { attempts: number[]; busy: boolean;
      creditQueries: { accept(owner: string, funded: boolean, kind: string): void } }
    if (limit === 'global') admission.attempts = Array(300).fill(performance.now())
    if (limit === 'busy') admission.busy = true
    if (limit === 'owner') for (let i = 0; i < 10; i++) admission.creditQueries.accept(f.owner.address, true, 'execute')
    const ledger = CreditLedger.load(store), before = ledger.balance(f.owner.address)
    const reads = Object.values(f.provider).filter(vi.isMockFunction)
    reads.forEach(read => read.mockClear())
    for (let i = 0; i < 2; i++) expect((await f.send(f.execution)).error).toBeDefined()
    reads.forEach(read => expect(read).not.toHaveBeenCalled())
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    expect(ledger.balance(f.owner.address)).toEqual(before)
    expect(ledger.nextSequence(f.owner.address)).toBe(f.quote.nextSequence)
    expect((await f.send({ kind: 'balance' })).available).toBe(before.available.toString())
  })
  it('returns a saved prepaid attempt even after new-execution budgets are exhausted', async () => {
    const f = await prepaidFixture(true); await f.fund()
    const accepted = await f.send(f.execution)
    expect(accepted.txHash).toBeDefined()
    const admission = f.service as unknown as { attempts: number[];
      creditQueries: { accept(owner: string, funded: boolean, kind: string): void } }
    admission.attempts = Array(300).fill(performance.now())
    for (let i = 0; i < 9; i++) admission.creditQueries.accept(f.owner.address, true, 'execute')
    const reads = Object.values(f.provider).filter(vi.isMockFunction)
    reads.forEach(read => read.mockClear())
    expect((await f.send(f.execution)).txHash).toBe(accepted.txHash)
    reads.forEach(read => expect(read).not.toHaveBeenCalled())
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.sender.broadcastTransaction).toHaveBeenCalledOnce()
  })
  it.each(['unsupported', 'canonical-change'])('closes native funding on historical read failure %s while keeping existing balance recovery available', async (failure) => {
    const f = await prepaidFixture(true); await f.fund()
    const historical = f.provider.getCode.getMockImplementation()!
    f.provider.getCode.mockImplementation(async (address, ...args: unknown[]) => {
      const block = args[0]
      if (typeof block === 'number' && block < 100) {
        if (failure === 'unsupported') throw new Error('historical state unavailable')
        f.provider.getBlock.mockImplementation(async (tag) => ({ number: typeof tag === 'number' ? tag : 100,
          hash: tag === 0 ? id('changed historical block') : blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }))
      }
      return historical(address)
    })
    const restarted = new Broadcaster(f.service.config, store, f.sdk, f.provider as unknown as JsonRpcProvider,
      f.wallet, f.sender, { rates: async () => f.rates })
    expect((await restarted.creditInfo()).executionEnabled).toBe(false)
    f.provider.getCode.mockRejectedValue(new Error('historical state remains unavailable'))
    const wire = await f.request({ kind: 'quote' })
    expect(wire.decode(await restarted.handle(wire.payload)).error).toBeDefined()
    const check = await f.request({ kind: 'balance' })
    expect(check.decode(await restarted.handle(check.payload)).available).toBe((10n ** 18n).toString())
    expect(await restarted.available()).toBe(false)
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('does not reinterpret an existing private ledger when native mode is selected', async () => {
    const f = await prepaidFixture(); await f.fund()
    const restarted = new Broadcaster({ ...f.service.config, creditPaymentMode: 'public-native' }, store, f.sdk,
      f.provider as unknown as JsonRpcProvider, f.wallet, f.sender, { rates: async () => f.rates })
    await expect(restarted.creditInfo()).rejects.toThrow()
    expect(CreditLedger.load(store).scope.funding).toBeUndefined()
    expect(CreditLedger.load(store).balance(f.owner.address).available).toBe(10n ** 18n)
    expect(f.sign).not.toHaveBeenCalled()
  })
  it.each(['execute', 'refund'])('keeps native funding closed until the included %s settles, with recovery still accessible', async (kind) => {
    const f = await prepaidFixture(true), payment = (await f.fund())!
    let payload: Record<string, unknown> = f.execution
    if (kind === 'refund') {
      const quote = await f.send({ kind: 'quote', refund: true }), recipient = Wallet.createRandom().address, net = 10n ** 16n
      payload = { kind, sequence: quote.nextSequence, recipient, gross: (net + BigInt(quote.maximumCharge)).toString(),
        net: net.toString(), feesID: quote.feesID, collectionAllowance: '0', refundGasAllowance: quote.refundGasAllowance }
      f.provider.send.mockResolvedValue({ type: 'CALL', from: f.wallet.address, to: recipient, input: '0x', value: `0x${net.toString(16)}` })
    }
    const sent = await f.send(payload)
    expect(sent.error).toBeUndefined()
    const saved = store.pending()[0], ledger = CreditLedger.load(store), tx = Transaction.from(saved.raw!)
    expect(ledger.hasUnsettledNativeAttempt()).toBe(true)
    expect((await f.service.creditInfo()).executionEnabled).toBe(false)
    ledger.observeInclusion(saved.key, { hash: saved.hash!, blockNumber: 100, blockHash, gasUsed: 21_000n,
      gasPrice: tx.maxFeePerGas ?? tx.gasPrice!, status: 1 } as TransactionReceipt)
    // Inclusion releases the legacy pending flag, but cannot release the native finality hold.
    expect(store.hasPending()).toBe(false)
    f.provider.getTransactionCount.mockResolvedValue(1)
    expect(await f.service.available()).toBe(false)
    expect((await f.service.creditInfo()).executionEnabled).toBe(false)
    expect((await f.send({ kind: 'quote' })).error).toBeTruthy()
    expect((await f.send({ kind: 'balance' })).reserved).toBe(ledger.balance(f.owner.address).reserved.toString())
    expect((await f.send({ kind: kind === 'refund' ? 'refund-status' : 'attempt', key: saved.key })).state).toBe('submitted-or-unknown')
    const restarted = new Broadcaster(f.service.config, store, f.sdk, f.provider as unknown as JsonRpcProvider,
      f.wallet, f.sender, { rates: async () => f.rates })
    expect((await restarted.creditInfo()).executionEnabled).toBe(false)
    expect(await restarted.available()).toBe(false)
    const restartSend = async (payload: Record<string, unknown>) => {
      const wire = await f.request(payload)
      return wire.decode(await restarted.handle(wire.payload))
    }
    const heldBalance = ledger.balance(f.owner.address)
    for (let retry = 0; retry < 2; retry++) {
      const claim = await restartSend({ kind: 'claim', transactionHash: payment.transactionHash, paymentId: payment.paymentId })
      expect(claim).toMatchObject({ kind: 'balance', available: heldBalance.available.toString(), reserved: heldBalance.reserved.toString() })
    }
    expect(ledger.nativeDeposits()).toHaveLength(1)
    expect(ledger.balance(f.owner.address)).toEqual(heldBalance)
    expect((await restartSend(recovery(payload))).state).toBe('submitted-or-unknown')
    const replay = await restartSend(payload)
    expect(kind === 'refund' ? replay.transactionHash : replay.txHash).toBe(saved.hash)
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it.each(['wrong-owner', 'wrong-ledger', 'missing-policy', 'public-with-pilot'])('holds new native refunds for %s while preserving paid claims and saved recovery', async (failure) => {
    const f = await prepaidFixture(true)
    await f.fund()
    const quote = await f.send({ kind: 'quote', refund: true }), recipient = Wallet.createRandom().address, net = 10n ** 16n
    expect(quote.kind).toBe('quote')
    const payload = { kind: 'refund', sequence: quote.nextSequence, recipient, gross: (net + BigInt(quote.maximumCharge)).toString(),
      net: net.toString(), feesID: quote.feesID, collectionAllowance: '0', refundGasAllowance: quote.refundGasAllowance }
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60_001)
    try {
      f.service.config.admission = 'pilot'
      f.service.config.prepaidPilotLedgerId = f.info.ledgerId
      f.service.config.prepaidPilotOwner = f.owner.address
      if (failure === 'wrong-owner') f.service.config.prepaidPilotOwner = Wallet.createRandom().address
      if (failure === 'wrong-ledger') f.service.config.prepaidPilotLedgerId = id('unapproved ledger')
      if (failure === 'missing-policy') { f.service.config.prepaidPilotLedgerId = undefined; f.service.config.prepaidPilotOwner = undefined }
      if (failure === 'public-with-pilot') f.service.config.admission = 'public'
      f.service.config.enabled = false
      await f.fund()
      expect((await f.send({ kind: 'quote' })).error).toBeTruthy()
      expect((await f.send({ kind: 'balance' })).available).toBe((10n ** 18n).toString())
      expect((await f.send({ kind: 'quote', refund: true })).error).toBeTruthy()
      expect((await f.send(payload)).error).toBeTruthy()
      clock.mockReturnValue(performance.now() + 60_001)
      f.service.config.enabled = true
      expect((await f.send(payload)).error).toBeTruthy()
      expect(CreditLedger.load(store).hasUnsettledNativeAttempt()).toBe(false)
      expect(store.pending()).toHaveLength(0)
      expect(f.sign).not.toHaveBeenCalled()
      f.service.config.admission = 'pilot'
      f.service.config.prepaidPilotOwner = f.owner.address
      f.service.config.prepaidPilotLedgerId = f.info.ledgerId
      store.db.prepare('INSERT INTO settings VALUES(?,?)').run(`prepaidWithdrawalPilot:${f.info.ledgerId}`, 'used')
      f.provider.send.mockResolvedValue({ type: 'CALL', from: f.wallet.address, to: recipient, input: '0x', value: `0x${net.toString(16)}` })
      expect((await f.send(payload)).state).toBe('submitted-or-unknown')
      f.service.config.prepaidPilotOwner = Wallet.createRandom().address
      expect((await f.send(payload)).state).toBe('submitted-or-unknown')
      expect((await f.send({ kind: 'refund-status', key: store.pending()[0].key })).state).toBe('submitted-or-unknown')
      expect(f.sign).toHaveBeenCalledOnce()
    } finally { clock.mockRestore() }
  })
  it('holds native refund principal plus gas before signing, then returns the saved refund on replay', async () => {
    const f = await prepaidFixture(true); await f.fund()
    const quote = await f.send({ kind: 'quote', refund: true }), recipient = Wallet.createRandom().address
    const net = 10n ** 16n, gross = net + BigInt(quote.maximumCharge)
    const payload = { kind: 'refund', sequence: quote.nextSequence, recipient, gross: gross.toString(), net: net.toString(),
      feesID: quote.feesID, collectionAllowance: '0', refundGasAllowance: quote.refundGasAllowance }
    f.provider.send.mockResolvedValue({ type: 'CALL', from: f.wallet.address, to: recipient, input: '0x', value: `0x${net.toString(16)}` })
    const result = await f.send(payload)
    expect(result).toMatchObject({ kind: 'refund', recipient, net: net.toString(), gross: gross.toString(), state: 'submitted-or-unknown', nonce: 0 })
    expect(f.sign).toHaveBeenCalledOnce()
    const saved = store.pending()[0], raw = Transaction.from(saved.raw!)
    expect(raw.to).toBe(recipient); expect(raw.value).toBe(net); expect(raw.data).toBe('0x')
    expect(CreditLedger.load(store).balance(f.owner.address).reserved).toBe(gross)
    expect((await f.send(payload)).transactionHash).toBe(result.transactionHash)
    expect(f.sign).toHaveBeenCalledOnce()
    expect((await f.send(f.execution)).error).toBeDefined()
    expect(f.sdk.confirmedRefund).not.toHaveBeenCalled()
  })
  it.each([1, 0])('settles a finalized native refund with status %i and releases its unused maximum hold', async (status) => {
    const f = await prepaidFixture(true), payment = (await f.fund())!
    const quote = await f.send({ kind: 'quote', refund: true }), recipient = Wallet.createRandom().address, net = 10n ** 16n
    const payload = { kind: 'refund', sequence: quote.nextSequence, recipient, gross: (net + BigInt(quote.maximumCharge)).toString(),
      net: net.toString(), feesID: quote.feesID, collectionAllowance: '0', refundGasAllowance: quote.refundGasAllowance }
    f.provider.send.mockResolvedValue({ type: 'CALL', from: f.wallet.address, to: recipient, input: '0x', value: `0x${net.toString(16)}` })
    const result = await f.send(payload), saved = store.pending()[0]
    const receipt = { hash: result.transactionHash, from: f.wallet.address, to: recipient,
      blockNumber: 100, blockHash, status, gasUsed: 21000n, gasPrice: 2n }
    f.provider.getTransactionReceipt.mockImplementation(async (hash) => hash === result.transactionHash ? receipt
      : hash === payment.transactionHash ? payment.receipt : null)
    f.provider.getTransactionCount.mockResolvedValue(1)
    f.provider.getBlock.mockImplementation(async (tag) => ({ number: tag === 'latest' ? 101 : 100, hash: blockHash,
      timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }))
    await f.service.reconcile()
    const updated = await f.send({ kind: 'refund-status', key: saved.key })
    const fee = 48_300n, paid = status === 1 ? net : 0n
    expect(updated).toMatchObject({ state: status === 1 ? 'refunded' : 'failed', netPaid: paid.toString(),
      charged: (paid + fee).toString(), settlementHash: result.transactionHash })
    const balance = CreditLedger.load(store).balance(f.owner.address)
    expect(CreditLedger.load(store).hasUnsettledNativeAttempt()).toBe(false)
    expect((await f.service.creditInfo()).executionEnabled).toBe(true)
    expect(balance.reserved).toBe(0n)
    expect(balance.available).toBe(10n ** 18n - paid - fee)
    const report = accountingReport(store.db)
    expect(report.receivedFees).toEqual({ [ZeroAddress]: fee.toString() })
    expect(report.prepaidCredit).toMatchObject({ funding: 'native', charged: fee.toString(),
      completedRefunds: paid.toString(), liability: balance.available.toString(), remainingEarned: '6300',
      nativeRefundReservations: '0', ownerPrivateFees: '0', ownerPaymentsPending: 0, nativeCollected: '0' })
    expect(f.sign).toHaveBeenCalledOnce()
    expect((await f.send(payload)).netPaid).toBe(paid.toString())
    await f.service.reconcile()
    expect(CreditLedger.load(store).balance(f.owner.address)).toEqual(balance)
  })
  it('retains a native refund hold after an unknown submission outcome without signing a replay', async () => {
    const f = await prepaidFixture(true); await f.fund()
    const quote = await f.send({ kind: 'quote', refund: true }), recipient = Wallet.createRandom().address, net = 10n ** 16n
    const payload = { kind: 'refund', sequence: quote.nextSequence, recipient, gross: (net + BigInt(quote.maximumCharge)).toString(),
      net: net.toString(), feesID: quote.feesID, collectionAllowance: '0', refundGasAllowance: quote.refundGasAllowance }
    f.provider.send.mockResolvedValue({ type: 'CALL', from: f.wallet.address, to: recipient, input: '0x', value: `0x${net.toString(16)}` })
    f.sender.broadcastTransaction.mockRejectedValueOnce(new Error('unknown protected submission'))
    expect((await f.send(payload)).error).toBeDefined()
    const saved = store.pending()[0]
    expect(saved.raw).toBeTruthy()
    expect(CreditLedger.load(store).balance(f.owner.address).reserved).toBe(BigInt(payload.gross))
    expect((await f.send(payload)).state).toBe('submitted-or-unknown')
    expect(f.sign).toHaveBeenCalledOnce(); expect(f.sender.broadcastTransaction).toHaveBeenCalledOnce()
  })
  it.each(['self', 'zero', 'underpaid', 'wrong-allowance', 'trace', 'reserve'])('rejects an unsafe native refund (%s) before reserving or signing', async (failure) => {
    const f = await prepaidFixture(true); await f.fund()
    const quote = await f.send({ kind: 'quote', refund: true }), net = 10n ** 16n
    const recipient = failure === 'self' ? f.wallet.address : failure === 'zero' ? ZeroAddress : Wallet.createRandom().address
    const payload = { kind: 'refund', sequence: quote.nextSequence, recipient,
      gross: (net + BigInt(quote.maximumCharge) - (failure === 'underpaid' ? 1n : 0n)).toString(), net: net.toString(),
      feesID: quote.feesID, collectionAllowance: '0', refundGasAllowance: failure === 'wrong-allowance' ? '1' : quote.refundGasAllowance }
    f.provider.send.mockResolvedValue({ type: 'CALL', from: f.wallet.address, to: recipient, input: '0x',
      value: `0x${net.toString(16)}`, ...(failure === 'trace' ? { error: 'revert' } : {}) })
    if (failure === 'reserve') f.provider.getBalance.mockResolvedValue(10n ** 18n)
    expect((await f.send(payload)).error).toBeDefined()
    expect(store.pending()).toHaveLength(0); expect(f.sign).not.toHaveBeenCalled()
  })
  it.each(['pending', 'unfinalized', 'empty-table'])('does not create a credit identity while an operator transfer is %s', async (stage) => {
    const f = await fixture(Wallet.createRandom().address)
    f.sdk.address = '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
    if (stage === 'empty-table') {
      store.db.exec(`CREATE TABLE credit_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        id TEXT NOT NULL, scope TEXT NOT NULL, initial_nonce INTEGER NOT NULL)`)
    }
    f.provider.getTransactionCount.mockImplementation(async (_address?: string, tag?: string | number) =>
      tag === 'pending' || (stage === 'unfinalized' && tag === 'latest') ? 1 : 0)
    await expect(f.service.creditInfo()).rejects.toThrow('Finalize every operator transaction')
    if (stage === 'empty-table') expect(store.db.prepare('SELECT 1 FROM credit_identity').get()).toBeUndefined()
    else expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_identity'").get()).toBeUndefined()
    f.provider.getTransactionCount.mockResolvedValue(1)
    const info = await f.service.creditInfo()
    expect(store.db.prepare('SELECT initial_nonce FROM credit_identity').get()?.initial_nonce).toBe(1)
    f.provider.getTransactionCount.mockImplementation(async (_address?: string, tag?: string | number) => tag === 'pending' ? 2 : 1)
    const restarted = new Broadcaster(f.service.config, store, f.sdk, f.provider as unknown as JsonRpcProvider,
      f.wallet, f.sender, { rates: async () => f.rates })
    expect((await restarted.creditInfo()).ledgerId).toBe(info.ledgerId)
    expect(f.sign).not.toHaveBeenCalled(); expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  async function scopedPilotWithdrawal(f: Awaited<ReturnType<typeof prepaidFixture>>, recipient: string,
    nullifier = id('scoped pilot nullifier')) {
    f.service.config.admission = 'pilot'
    f.service.config.pilotAccount = String(f.data.to)
    f.service.config.pilotWithdrawalRecipient = recipient
    const data = CHAIN_ID === 56
      ? await signedWithdrawalRequest(f.quote.feesID, f.sdk.publicViewingKey, recipient, TOKENS[1].address, nullifier,
        (transactions, action) => {
          transactions.shift()
          const gross = BigInt(transactions[0].unshieldPreimage.value)
          action.calls[0].data = ADAPT.encodeFunctionData('transfer', [[{
            token: { tokenType: 0, tokenAddress: TOKENS[1].address, tokenSubID: 0 }, to: recipient, value: gross - gross * 25n / 10_000n,
          }]])
        })
      : await withdrawalRequest(f.quote.feesID, f.sdk.publicViewingKey, recipient, 1, 1, TOKENS[1].address, nullifier)
    f.provider.send.mockResolvedValue({ type: 'CALL', calls: [{ type: 'CALL', to: NETWORK.proxyContract, input: privateCalldata(data) }] })
    return { ...f.execution, sequence: CreditLedger.load(store).nextSequence(f.owner.address), request: data }
  }
  it('uses native prepaid credit for a private token withdrawal without an embedded private fee', async () => {
    const f = await prepaidFixture(true); await f.fund()
    const payload = await scopedPilotWithdrawal(f, Wallet.createRandom().address)
    f.service.config.prepaidPilotLedgerId = f.info.ledgerId
    f.service.config.prepaidPilotOwner = f.owner.address
    expect((await f.send(payload)).txHash).toBeTruthy()
    expect(f.sdk.validatePrepaid).toHaveBeenCalledOnce()
    expect(f.sdk.fee).not.toHaveBeenCalled()
    expect(f.sdk.accountedCreditBacking).not.toHaveBeenCalled()
    expect(CreditLedger.load(store).scope.funding).toBe('native')
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM credit_deposits').get()?.n).toBe(0)
  })
  it('keeps the historical pilot halt without an explicit exact prepaid ledger approval', async () => {
    const f = await prepaidFixture(); await f.fund()
    const payload = await scopedPilotWithdrawal(f, Wallet.createRandom().address)
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run('withdrawalPilot', 'historic-withdrawal')
    expect(await f.service.available()).toBe(false)
    expect((await f.send(payload)).error).toBeTruthy()
    f.service.config.prepaidPilotLedgerId = id('different-ledger')
    expect(await f.service.available()).toBe(false)
    expect((await f.send(payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled(); expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    expect(CreditLedger.load(store).id).toBe(f.info.ledgerId)
  })
  it('permits one approved prepaid withdrawal while retaining the historic marker across replay and restart', async () => {
    const f = await prepaidFixture(); await f.fund()
    const payload = await scopedPilotWithdrawal(f, Wallet.createRandom().address)
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run('withdrawalPilot', 'historic-withdrawal')
    f.service.config.prepaidPilotLedgerId = f.info.ledgerId
    f.service.config.prepaidPilotOwner = f.owner.address
    expect(await f.service.available()).toBe(true)
    const result = await f.send(payload)
    expect(result.txHash).toBeTruthy()
    expect((await f.send(payload)).txHash).toBe(result.txHash)
    expect(f.sign).toHaveBeenCalledOnce()
    const saved = store.pending()[0], transaction = Transaction.from(saved.raw!)
    f.provider.getTransactionReceipt.mockResolvedValue({ hash: result.txHash, from: f.wallet.address,
      status: 0, blockNumber: 99, blockHash, gasUsed: 100_000n,
      gasPrice: transaction.maxFeePerGas ?? transaction.gasPrice! } as TransactionReceipt)
    f.provider.getTransactionCount.mockResolvedValue(1)
    f.provider.getBlock.mockImplementation(async (tag?: string | number) => ({ number: typeof tag === 'number' ? tag : 100,
      hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }))
    await f.service.reconcile()
    expect(store.hasPending()).toBe(false)
    expect(await f.service.available()).toBe(false)
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe('historic-withdrawal')
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get(`prepaidWithdrawalPilot:${f.info.ledgerId}`)?.value).toBe(saved.key)
    store.close(); store = new Store(directory)
    f.service.config.pilotAccount = Wallet.createRandom().address
    f.service.config.pilotWithdrawalRecipient = Wallet.createRandom().address
    const restarted = new Broadcaster(f.service.config, store, f.sdk, f.provider as unknown as JsonRpcProvider, f.wallet,
      f.sender, { rates: async () => f.rates })
    expect(await restarted.available()).toBe(false)
    expect((restarted as any).creditService).toBeUndefined()
    const info = await packetFor({ protocol: CREDIT_PROTOCOL, kind: 'info', correlation: id('pilot restart info'),
      broadcasterViewingKey: f.sdk.publicViewingKey }, f.sdk.publicViewingKey)
    expect(info.decode(await restarted.handle(info.payload)).ledgerId).toBe(f.info.ledgerId)
    expect(await restarted.available()).toBe(false)
    const duplicate = await f.request(payload)
    expect(duplicate.decode(await restarted.handle(duplicate.payload)).txHash).toBe(result.txHash)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe('historic-withdrawal')
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get(`prepaidWithdrawalPilot:${f.info.ledgerId}`)?.value).toBe(saved.key)
  })
  it('closes new funding quotes for an unapproved credit owner while preserving existing credit recovery', async () => {
    const f = await prepaidFixture(); await f.fund()
    f.service.config.admission = 'pilot'
    f.service.config.pilotAccount = Wallet.createRandom().address
    f.service.config.prepaidPilotLedgerId = f.info.ledgerId
    f.service.config.prepaidPilotOwner = Wallet.createRandom().address
    expect((await f.service.creditInfo()).executionEnabled).toBe(true)
    f.provider.call.mockClear()
    expect((await f.send({ kind: 'quote' })).error).toBeTruthy()
    expect(f.provider.call).not.toHaveBeenCalled()
    expect((await f.send({ kind: 'balance' })).available).toBe((10n ** 18n).toString())
    expect((await f.send({ kind: 'quote', refund: true })).kind).toBe('quote')
    f.service.config.prepaidPilotLedgerId = undefined; f.service.config.prepaidPilotOwner = undefined
    expect((await f.service.creditInfo()).executionEnabled).toBe(false)
    expect((await f.send({ kind: 'quote' })).error).toBeTruthy()
    expect((await f.send({ kind: 'balance' })).available).toBe((10n ** 18n).toString())
  })
  it('reports exhausted pilot and journal recovery holds without RPC or enabling fresh funding', async () => {
    const f = await prepaidFixture(); await f.fund()
    f.service.config.admission = 'pilot'
    f.service.config.prepaidPilotLedgerId = f.info.ledgerId; f.service.config.prepaidPilotOwner = f.owner.address
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run(`prepaidWithdrawalPilot:${f.info.ledgerId}`, 'consumed')
    f.provider.call.mockClear(); f.provider.getBlock.mockClear()
    expect((await f.service.creditInfo()).executionEnabled).toBe(false)
    expect(f.provider.call).not.toHaveBeenCalled(); expect(f.provider.getBlock).not.toHaveBeenCalled()
    f.service.config.admission = 'public'; f.service.config.prepaidPilotLedgerId = undefined; f.service.config.prepaidPilotOwner = undefined
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run('creditOwnerRecoveryRequired', 'held')
    expect((await f.service.creditInfo()).executionEnabled).toBe(false)
    expect((await f.send({ kind: 'balance' })).available).toBe((10n ** 18n).toString())
  })
  it('prices both protocol deductions before reserving the operating margin', async () => {
    const f = await prepaidFixture()
    const denominator = 9975n * 9987n
    const expected = (10n ** 18n * (10_000n + f.service.config.marginBps) * 10_000n + denominator - 1n) / denominator
    expect(BigInt(f.quote.rate)).toBe(expected)
  })
  it('rejects unfunded refund quotes before any RPC, scan or quote record is created', async () => {
    const f = await prepaidFixture()
    f.provider.call.mockClear(); f.sdk.accountedCreditBacking.mockClear()
    const feesBefore = store.db.prepare('SELECT COUNT(*) AS count FROM fees').get()!.count
    expect((await f.send({ kind: 'quote', refund: true })).error).toBeTruthy()
    expect(f.provider.call).not.toHaveBeenCalled()
    expect(f.sdk.accountedCreditBacking).not.toHaveBeenCalled()
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM fees').get()!.count).toBe(feesBefore)
  })
  it('shares short-lived backing observations across funded refund quotes and invalidates them after a new deposit', async () => {
    const f = await prepaidFixture(); await f.fund()
    expect((await f.send({ kind: 'quote', refund: true })).kind).toBe('quote')
    expect((await f.send({ kind: 'quote', refund: true })).kind).toBe('quote')
    expect(f.sdk.accountedCreditBacking).toHaveBeenCalledTimes(1)
    const note = syntheticNote(100n, 1); f.addBacking(note)
    f.sdk.confirmedCredits.mockResolvedValueOnce([{ ...provenance(note), owner: f.owner.address, amount: 100n }])
    expect((await f.send({ kind: 'claim', transactionHash: note.txid })).kind).toBe('balance')
    expect((await f.send({ kind: 'quote', refund: true })).kind).toBe('quote')
    expect(f.sdk.accountedCreditBacking).toHaveBeenCalledTimes(2)
  })
  it('does not invalidate the shared backing proof when a funded customer reclaims the identical deposit', async () => {
    const f = await prepaidFixture(); await f.fund()
    expect((await f.send({ kind: 'quote', refund: true })).kind).toBe('quote')
    expect(f.sdk.accountedCreditBacking).toHaveBeenCalledTimes(1)
    const note = CreditLedger.load(store).accountedNotes()[0]
    f.sdk.confirmedCredits.mockResolvedValueOnce([{ ...note, owner: f.owner.address, amount: BigInt(note.amount) }])
    expect((await f.send({ kind: 'claim', transactionHash: note.transactionHash })).kind).toBe('balance')
    expect((await f.send({ kind: 'quote', refund: true })).kind).toBe('quote')
    expect(f.sdk.accountedCreditBacking).toHaveBeenCalledTimes(1)
  })
  it.each(['insufficient', 'already-pending'])('rejects an unaffordable refund before canonical backing work: %s', async (reason) => {
    const f = await prepaidFixture(); await f.fund()
    const fee = (BigInt(f.quote.collectionAllowance) * BigInt(f.quote.rate) + 10n ** 18n - 1n) / 10n ** 18n
    const request = { kind: 'refund', sequence: f.quote.nextSequence,
      recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm',
      gross: (10n ** 17n).toString(), net: (10n ** 17n - fee).toString(), feesID: f.quote.feesID, collectionAllowance: f.quote.collectionAllowance }
    if (reason === 'already-pending') {
      expect((await f.send(request)).kind).toBe('refund')
      request.sequence++
    } else {
      request.gross = (10n ** 18n + 1n).toString(); request.net = (10n ** 18n + 1n - fee).toString()
    }
    const credits = (f.service as any).creditService
    credits.backingCache = undefined
    f.sdk.accountedCreditBacking.mockClear(); f.provider.call.mockClear()
    expect((await f.send(request)).error).toBeTruthy()
    expect(f.sdk.accountedCreditBacking).not.toHaveBeenCalled()
    expect(f.provider.call).not.toHaveBeenCalled()
    if (reason === 'already-pending') {
      expect(await f.send({ kind: 'quote', refund: true })).toMatchObject({ maximumRefundGross: '0' })
      expect(f.sdk.accountedCreditBacking).not.toHaveBeenCalled()
    }
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('checks historical owner receipts once, then verifies their canonical anchor and newly appended settlements', async () => {
    const f = await prepaidFixture(); await f.fund()
    const credits = (f.service as any).creditService
    const payment = (number: number) => ({ transaction_hash: id(`owner-${number}`), block_number: number, block_hash: id(`block-${number}`) })
    const history = [payment(10), payment(20)]
    vi.spyOn(credits.ledger, 'ownerSettlements').mockImplementation(() => history)
    f.provider.getBlock.mockImplementation(async (tag?: any) => {
      const number = typeof tag === 'number' ? tag : 100
      return { number, hash: id(`block-${number}`), timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }
    })
    f.provider.getTransactionReceipt.mockImplementation(async (hash) => {
      const row = history.find((item) => item.transaction_hash === hash)!
      return { hash: row.transaction_hash, blockNumber: row.block_number, blockHash: row.block_hash,
        status: 1, gasUsed: 1n, gasPrice: 1n } as any
    })
    await credits.checkedBacking()
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledTimes(2)
    credits.backingCache = undefined
    await credits.checkedBacking()
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledTimes(2)
    history.push(payment(30)); credits.backingCache = undefined
    await credits.checkedBacking()
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledTimes(3)
    credits.backingCache = undefined
    const getBlock = f.provider.getBlock.getMockImplementation()! as (tag?: unknown) => Promise<any>
    f.provider.getBlock.mockImplementation(async (tag?: any) => tag === 30 ? null as any : getBlock(tag))
    await expect(credits.checkedBacking()).rejects.toThrow('unavailable')
    expect(store.db.prepare('SELECT 1 FROM settings WHERE key=?').get('creditOwnerRecoveryRequired')).toBeUndefined()
    f.provider.getBlock.mockImplementation(async (tag?: any) => ({ ...await getBlock(tag), ...(tag === 30 ? { hash: id('reorganized') } : {}) }))
    await expect(credits.checkedBacking()).rejects.toThrow('canonical reconciliation')
    expect(store.db.prepare('SELECT 1 FROM settings WHERE key=?').get('creditOwnerRecoveryRequired')).toBeDefined()
  })
  it.each(['fee', 'code'])('rejects a previously quoted execution if the pinned ANON %s changes', async (change) => {
    const f = await prepaidFixture(); await f.fund()
    if (change === 'fee') {
      const original = f.provider.call.getMockImplementation()!
      f.provider.call.mockImplementation(async (tx) => tx.data === ANON_COLLECTION_ABI.encodeFunctionData('baseFeeBP')
        ? ANON_COLLECTION_ABI.encodeFunctionResult('baseFeeBP', [14n]) : original(tx))
    } else {
      const original = f.provider.getCode.getMockImplementation()!
      f.provider.getCode.mockImplementation(async (address) => address === ANON_COLLECTION_GATEWAY ? '0x6001' : original(address))
    }
    expect((await f.send(f.execution)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(store.hasPending()).toBe(false)
  })
  it('retires an exact never-admitted execution without spending and rejects its late original request', async () => {
    const f = await prepaidFixture(); await f.fund()
    const payload = JSON.stringify(f.execution), key = creditRequestKey(f.info.ledgerId, f.owner.address, payload)
    const recovered = await f.send(recovery(f.execution))
    expect(recovered).toMatchObject({ kind: 'recovery', recoveredKey: key, operation: 'execute', state: 'not-reserved' })
    expect(await f.send(recovery(f.execution))).toMatchObject(recovered)
    expect((await f.send(f.execution)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    expect(store.pending()).toHaveLength(0)
    expect((await f.send({ kind: 'balance' })).reserved).toBe('0')
  })
  it('rejects consumed execution and refund sequences before additional pricing, backing or simulation', async () => {
    const f = await prepaidFixture(); await f.fund()
    expect(f.quote.nextSequence).toBe(1)
    expect(await f.send(recovery(f.execution))).toMatchObject({ sequence: 1, retiredThrough: 1 })
    f.provider.call.mockClear(); f.provider.getTransactionCount.mockClear(); f.provider.estimateGas.mockClear()
    f.sdk.accountedCreditBacking.mockClear()
    expect((await f.send(f.execution)).error).toBeTruthy()
    expect((await f.send({ kind: 'refund', sequence: 1, recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', gross: '100', net: '90',
      feesID: f.quote.feesID, collectionAllowance: f.quote.collectionAllowance })).error).toBeTruthy()
    expect(f.provider.call).not.toHaveBeenCalled()
    expect(f.provider.getTransactionCount).not.toHaveBeenCalled()
    expect(f.provider.estimateGas).not.toHaveBeenCalled()
    expect(f.sdk.accountedCreditBacking).not.toHaveBeenCalled()
    expect((await f.send({ kind: 'quote' })).nextSequence).toBe(2)
  })
  it('permanently rejects new legacy admissions while allowing write-free legacy absence recovery', async () => {
    const f = await prepaidFixture(); await f.fund()
    const { sequence: _sequence, ...legacy } = f.execution
    const refund = { kind: 'refund', recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', gross: '100', net: '90',
      feesID: f.quote.feesID, collectionAllowance: f.quote.collectionAllowance }
    for (const original of [legacy, refund]) {
      expect((await f.send(original)).error).toBeTruthy()
      expect(await f.send(recovery(original))).toMatchObject({ kind: 'recovery', sequence: null, retiredThrough: 0 })
      expect((await f.send({ ...recovery(original), sequence: null })).error).toBeTruthy()
    }
    expect((await f.send({ ...recovery(f.execution), sequence: 3 })).error).toBeTruthy()
    expect(store.db.prepare('SELECT * FROM credit_owner_sequences').all()).toHaveLength(0)
    expect(store.db.prepare('SELECT * FROM credit_retired_requests').all()).toHaveLength(0)
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('returns a legacy execution hold before the new sequence admission gate', async () => {
    const f = await prepaidFixture(); await f.fund()
    const { sequence: _sequence, ...legacy } = f.execution
    const key = creditRequestKey(f.info.ledgerId, f.owner.address, JSON.stringify(legacy))
    // Existing pre-upgrade journal state; the current service must not release or resubmit it.
    store.db.exec('DROP TRIGGER require_credit_attempts_sequence')
    store.db.prepare(`INSERT INTO credit_attempts(key,owner,unsigned,maximum_charge,rate,collection_allowance)
      VALUES(?,?,?,?,?,?)`).run(key, f.owner.address, '0x', f.quote.maximumCharge, f.quote.rate, f.quote.collectionAllowance)
    store.db.prepare(`INSERT INTO requests(key,envelope,created,max_cost,signed_at,fee_data,nonce,fee_expiration)
      VALUES(?,?,?,?,?,?,?,?)`).run(key, 'synthetic legacy envelope', Date.now(), '1', Date.now(),
      JSON.stringify({ kind: 'prepaid', ledgerId: f.info.ledgerId, owner: f.owner.address }), 0, Date.now() + 60_000)
    expect(await f.send(legacy)).toMatchObject({ kind: 'attempt', state: 'reserved-or-submitted' })
    expect(await f.send(recovery(legacy))).toMatchObject({ kind: 'attempt', state: 'reserved-before-signing' })
    expect((await f.send({ kind: 'balance' })).reserved).toBe(f.quote.maximumCharge)
    expect(store.db.prepare('SELECT * FROM credit_owner_sequences').all()).toHaveLength(0)
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('recovers a maximum-size saved payload through a fixed-size owner-bound hash envelope', async () => {
    const f = await prepaidFixture(); await f.fund()
    const original = { ...f.execution, padding: '' }
    original.padding = 'x'.repeat(CREDIT_MAX_PAYLOAD - JSON.stringify(original).length)
    const payload = JSON.stringify(original), payloadHash = id(payload)
    expect(payload.length).toBe(CREDIT_MAX_PAYLOAD)
    expect(() => creditAuthorizationValue(f.info.scope, f.owner.address, payload, Date.now() + 60_000)).not.toThrow()
    expect(JSON.stringify({ kind: 'recover', payload }).length).toBeGreaterThan(CREDIT_MAX_PAYLOAD)
    expect(JSON.stringify(recovery(original)).length).toBeLessThan(150)
    const key = creditRequestKey(f.info.ledgerId, f.owner.address, payload)
    expect(creditRequestKeyFromPayloadHash(f.info.ledgerId, f.owner.address, payloadHash)).toBe(key)
    expect(creditRequestKeyFromPayloadHash(id('other-ledger'), f.owner.address, payloadHash)).not.toBe(key)
    expect(creditRequestKeyFromPayloadHash(f.info.ledgerId, Wallet.createRandom().address, payloadHash)).not.toBe(key)
    for (const malformed of ['', '0x12', `0x${'11'.repeat(33)}`])
      expect(() => creditRequestKeyFromPayloadHash(f.info.ledgerId, f.owner.address, malformed)).toThrow('payload hash')
    expect(await f.send(recovery(original))).toMatchObject({ kind: 'recovery', recoveredKey: key,
      operation: 'execute', state: 'not-reserved' })
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it.each(['execute', 'refund'])('fences delayed %s admission that resumes after recovery retirement', async (operation) => {
    const f = await prepaidFixture(); await f.fund()
    const gross = 10n ** 18n, fee = (BigInt(f.quote.collectionAllowance) * BigInt(f.quote.rate) + 10n ** 18n - 1n) / 10n ** 18n
    const original = operation === 'execute' ? f.execution : { kind: 'refund', sequence: f.quote.nextSequence, recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm',
      gross: String(gross), net: String(gross - fee), feesID: f.quote.feesID, collectionAllowance: f.quote.collectionAllowance }
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    if (operation === 'execute') f.sdk.accountedCreditBacking.mockImplementationOnce(async () => { entered(); await wait; return f.backing() })
    else f.provider.call.mockImplementationOnce(async () => { entered(); await wait; return PROXY.encodeFunctionResult('unshieldFee', [0n]) })
    const wire = await f.request(original), pending = f.service.handle(wire.payload)
    await started
    const recovered = await f.send(recovery(original))
    release()
    expect(recovered).toMatchObject({ kind: 'recovery', operation, state: 'not-reserved' })
    expect(wire.decode(await pending).error).toBeTruthy()
    expect(store.db.prepare('SELECT * FROM credit_attempts').all()).toHaveLength(0)
    expect(store.db.prepare('SELECT * FROM credit_refunds').all()).toHaveLength(0)
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('derives recovery keys from the authenticated owner and exact payload instead of an arbitrary supplied key', async () => {
    const f = await prepaidFixture(); await f.fund()
    const payload = JSON.stringify(f.execution), victimKey = creditRequestKey(f.info.ledgerId, f.owner.address, payload)
    const stranger = Wallet.createRandom(), wire = await f.request({ ...recovery(f.execution), key: victimKey }, stranger)
    expect(wire.decode(await f.service.handle(wire.payload)).error).toBeTruthy()
    expect(store.db.prepare('SELECT * FROM credit_retired_requests').all()).toHaveLength(0)
    const strangerNote = syntheticNote(1n, 1, 10, 0, id('stranger funding'))
    f.addBacking(strangerNote)
    f.sdk.confirmedCredits.mockResolvedValueOnce([{ ...provenance(strangerNote), owner: stranger.address, amount: 1n }])
    const claim = await f.request({ kind: 'claim', transactionHash: id('stranger funding') }, stranger)
    expect(claim.decode(await f.service.handle(claim.payload)).available).toBe('1')
    expect(wire.decode(await f.service.handle(wire.payload))).toMatchObject({ kind: 'recovery', state: 'not-reserved',
      recoveredKey: creditRequestKey(f.info.ledgerId, stranger.address, payload) })
    expect(store.db.prepare('SELECT * FROM credit_retired_requests WHERE key=?').get(victimKey)).toBeUndefined()
    for (const payloadHash of [undefined, null, {}, '', 'invalid', '0x', '0x12', `0x${'11'.repeat(33)}`])
      expect((await f.send({ kind: 'recover', payloadHash, operation: 'execute' })).error).toBeTruthy()
    for (const operation of [undefined, null, {}, '', 'balance', 'recover'])
      expect((await f.send({ kind: 'recover', payloadHash: id(payload), operation })).error).toBeTruthy()
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM credit_retired_requests').get()?.count).toBe(0)
    expect(store.db.prepare('SELECT * FROM credit_owner_sequences').all()).toEqual([{ owner: stranger.address, sequence: 1 }])
    expect((await f.send(f.execution)).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('recovers an existing unsigned reservation after its quote is pruned without releasing it', async () => {
    const f = await prepaidFixture(); await f.fund()
    f.sign.mockRejectedValueOnce(new Error('Synthetic signer unavailable'))
    expect((await f.send(f.execution)).error).toContain('outcome is unknown')
    store.db.prepare('DELETE FROM fees').run()
    expect((await f.send({ ...recovery(f.execution), operation: 'refund' })).error).toBeTruthy()
    const result = await f.send(recovery(f.execution))
    expect(result).toMatchObject({ kind: 'attempt', state: 'reserved-before-signing', maximumCharge: f.quote.maximumCharge })
    expect((await f.send({ kind: 'balance' })).reserved).toBe(f.quote.maximumCharge)
    expect(store.db.prepare('SELECT * FROM credit_retired_requests').all()).toHaveLength(0)
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('replays an existing refund idempotently after quote expiry and recovers a never-reserved pruned quote', async () => {
    const f = await prepaidFixture(); await f.fund()
    const gross = 10n ** 18n, fee = (BigInt(f.quote.collectionAllowance) * BigInt(f.quote.rate) + 10n ** 18n - 1n) / 10n ** 18n
    const original = { kind: 'refund', sequence: f.quote.nextSequence, recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', gross: String(gross), net: String(gross - fee),
      feesID: f.quote.feesID, collectionAllowance: f.quote.collectionAllowance }
    const first = await f.send(original)
    expect(first.state).toBe('awaiting-owner-transfer')
    store.db.prepare('DELETE FROM fees').run()
    expect(await f.send(original)).toMatchObject(first)
    expect((await f.send({ ...recovery(original), operation: 'execute' })).error).toBeTruthy()
    expect(await f.send(recovery(original))).toMatchObject({ kind: 'refund',
      state: 'awaiting-owner-transfer' })
    expect(store.db.prepare('SELECT * FROM credit_refunds').all()).toHaveLength(1)
    const neverReserved = { ...original, gross: '100', net: '90' }
    expect((await f.send(neverReserved)).error).toBeTruthy()
    expect(await f.send(recovery(neverReserved))).toMatchObject({ kind: 'recovery',
      operation: 'refund', state: 'not-reserved' })
    expect((await f.send({ kind: 'balance' })).refunds).toBe(String(gross))
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('keeps authenticated credit recovery and refund requests available when new execution is disabled', async () => {
    const f = await prepaidFixture(); await f.fund()
    f.service.config.enabled = false
    expect((await f.send(f.execution)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect((await f.send({ kind: 'balance' })).available).toBe((10n ** 18n).toString())
    expect((await f.send({ kind: 'quote' })).error).toBeTruthy()
    const quote = await f.send({ kind: 'quote', refund: true })
    const gross = 10n ** 18n, fee = (BigInt(quote.collectionAllowance) * BigInt(quote.rate) + 10n ** 18n - 1n) / 10n ** 18n
    const refund = await f.send({ kind: 'refund', sequence: quote.nextSequence, recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', gross: String(gross), net: String(gross - fee),
      feesID: quote.feesID, collectionAllowance: quote.collectionAllowance })
    expect(refund.state).toBe('awaiting-owner-transfer')
    f.sdk.confirmedRefund.mockClear()
    await f.service.reconcile()
    expect(f.sdk.confirmedRefund).not.toHaveBeenCalled()
    expect((await f.send({ kind: 'balance' })).available).toBe('0')
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('never accepts a public request to assign an owner payout to a refund', async () => {
    const f = await prepaidFixture(); await f.fund()
    expect((await f.send({ kind: 'record-refund-payout', key: id('refund'), transactionHash: id('payout') })).error).toBeTruthy()
    expect(store.db.prepare('SELECT 1 FROM credit_refund_payouts').all()).toEqual([])
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sdk.confirmedRefund).not.toHaveBeenCalled()
  })
  it('does not let anonymous discovery consume paid execution admission', async () => {
    const f = await prepaidFixture(); await f.fund()
    const wire = await packetFor({ protocol: CREDIT_PROTOCOL, kind: 'info', correlation: id('flood'), broadcasterViewingKey: f.sdk.publicViewingKey }, f.sdk.publicViewingKey)
    for (let i = 0; i < 300; i++) await f.service.handle(wire.payload)
    expect(wire.decode(await f.service.handle(wire.payload)).error).toBeTruthy()
    expect((await f.send(f.execution)).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it.each([0, 1])('charges the secured credit for a finalized operation with receipt status %i', async (status) => {
    const f = await prepaidFixture(); await f.fund()
    const result = await f.send(f.execution), saved = store.pending()[0], tx = Transaction.from(saved.raw!)
    const receipt = { hash: result.txHash, from: f.wallet.address, status, blockNumber: 99, blockHash,
      gasUsed: 70_000n, gasPrice: tx.maxFeePerGas! } as TransactionReceipt
    f.provider.getTransactionReceipt.mockResolvedValue(receipt)
    f.provider.getTransactionCount.mockResolvedValue(1)
    f.provider.getBlock.mockImplementation(async (tag?: string | number) => ({ number: typeof tag === 'number' ? tag : 100,
      hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }))
    await f.service.reconcile()
    const attempt = await f.send({ kind: 'attempt', key: saved.key })
    expect(attempt.state).toBe('settled')
    expect(attempt.settlementHash).toBe(result.txHash)
    const charge = ((receipt.gasUsed * receipt.gasPrice + BigInt(f.quote.collectionAllowance)) * BigInt(f.quote.rate) + 10n ** 18n - 1n) / 10n ** 18n
    expect(attempt.charged).toBe(String(charge))
    expect((await f.send({ kind: 'balance' })).available).toBe(String(10n ** 18n - charge))
    expect(store.get(saved.key)?.assured).toBe(1)
    await f.service.reconcile()
    expect((await f.send({ kind: 'balance' })).charged).toBe(String(charge))
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it.runIf(CHAIN_ID === 1)('retains the full hold before finality and restores nonce recovery after a prefinality reorg', async () => {
    const f = await prepaidFixture(); await f.fund()
    const result = await f.send(f.execution), saved = store.pending()[0], tx = Transaction.from(saved.raw!)
    f.provider.getTransactionReceipt.mockResolvedValue({ hash: result.txHash, from: f.wallet.address, status: 1, blockNumber: 99,
      blockHash, gasUsed: 70_000n, gasPrice: tx.maxFeePerGas! } as TransactionReceipt)
    f.provider.getTransactionCount.mockResolvedValue(1)
    f.provider.getBlock.mockImplementation(async (tag?: string | number) => ({ number: typeof tag === 'number' ? tag : tag === 'finalized' ? 98 : 100,
      hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }))
    await f.service.reconcile()
    expect(store.hasPending()).toBe(false)
    expect((await f.send({ kind: 'balance' })).reserved).toBe(f.quote.maximumCharge)
    expect(store.exposure()).toBe(BigInt(saved.max_cost))
    f.provider.getTransactionReceipt.mockResolvedValue(null)
    f.provider.getTransactionCount.mockResolvedValue(0)
    await f.service.reconcile()
    expect(store.hasPending()).toBe(true)
    expect(store.get(saved.key)?.confirmed).toBe(0)
    expect((await f.send({ kind: 'balance' })).reserved).toBe(f.quote.maximumCharge)
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('rejects an unpaid operation before signing and reserves confirmed credit before the signer runs', async () => {
    const f = await prepaidFixture()
    expect((await f.send(f.execution)).error).toContain('Prepaid request rejected')
    expect(f.sign).not.toHaveBeenCalled()
    await f.fund()
    f.sign.mockImplementationOnce(async (tx) => {
      const rows = store.db.prepare('SELECT * FROM credit_attempts').all()
      expect(rows).toHaveLength(1)
      expect(store.get(String(rows[0].key))?.raw).toBeNull()
      return Wallet.prototype.signTransaction.call(f.wallet, tx)
    })
    const result = await f.send(f.execution)
    expect(result.error).toBeUndefined()
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(f.sdk.fee).not.toHaveBeenCalled()
    expect(f.sdk.validatePrepaid).toHaveBeenCalledOnce()
    const retry = await f.send(f.execution)
    expect(retry.txHash).toBe(result.txHash)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.sender.broadcastTransaction).toHaveBeenCalledOnce()
  })
  it.each(['estimate', 'trace'])('rejects a prepaid contract failure at %s before fee-note decoding or signing', async (stage) => {
    const f = await prepaidFixture(); await f.fund()
    if (stage === 'estimate') f.provider.estimateGas.mockRejectedValue(new Error('Invalid spend proof'))
    else f.provider.send.mockResolvedValue({ type: 'CALL', error: 'Invalid spend proof' })
    expect((await f.send(f.execution)).error).toBeTruthy()
    expect(f.sdk.validatePrepaid).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    expect((await f.send({ kind: 'balance' })).reserved).toBe('0')
  })
  it('retains a reservation when signing fails and never silently retries or releases it', async () => {
    const f = await prepaidFixture(); await f.fund()
    f.sign.mockRejectedValueOnce(new Error('Owner signer disconnected'))
    expect((await f.send(f.execution)).error).toContain('outcome is unknown')
    expect(store.hasPending()).toBe(true)
    expect(store.pending()[0].raw).toBeNull()
    expect((await f.send({ kind: 'balance' })).reserved).toBe(f.quote.maximumCharge)
    const retry = await f.send(f.execution)
    expect(retry.state).toBe('reserved-or-submitted')
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it.runIf(CHAIN_ID === 56)('permits prepaid BNB pilot execution only for the approved account', async () => {
    const f = await prepaidFixture(); await f.fund()
    f.service.config.mode = 'mainnet'; f.service.config.admission = 'public'
    expect((await f.send(f.execution)).error).toBeTruthy()
    f.service.config.admission = 'pilot'; f.service.config.pilotAccount = Wallet.createRandom().address
    f.service.config.prepaidPilotLedgerId = f.info.ledgerId; f.service.config.prepaidPilotOwner = f.owner.address
    expect((await f.send(f.execution)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    f.service.config.pilotAccount = String(f.data.to)
    expect((await f.send(f.execution)).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('holds an authenticated refund and rejects execution when private backing is missing', async () => {
    const f = await prepaidFixture(); await f.fund()
    f.sdk.accountedCreditBacking.mockRejectedValueOnce(new Error('Missing fee assets'))
    expect((await f.send(f.execution)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    const gross = 10n ** 18n, fee = (BigInt(f.quote.collectionAllowance) * BigInt(f.quote.rate) + 10n ** 18n - 1n) / 10n ** 18n
    const refund = await f.send({ kind: 'refund', sequence: f.quote.nextSequence, recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', gross: gross.toString(), net: (gross - fee).toString(),
      feesID: f.quote.feesID, collectionAllowance: f.quote.collectionAllowance })
    expect(refund.state).toBe('awaiting-owner-transfer')
    expect((await f.send({ kind: 'balance' })).available).toBe('0')
    expect((await f.send({ kind: 'refund-status', key: refund.key })).state).toBe('awaiting-owner-transfer')
    expect((await f.send(f.execution)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
  })
})

async function confirm(f: Awaited<ReturnType<typeof fixture>>, hash: string, status = 1) {
  const record = store.pending().find((r) => r.hash === hash)!
  f.provider.getTransactionCount.mockImplementation(async (address?: string) => address === f.service.wallet.address ? record.nonce + 1 : 0)
  f.provider.getTransactionReceipt.mockImplementation(async (requested?: string) => requested === hash
    ? { status, blockNumber: 99, blockHash, gasUsed: 100_000n, gasPrice: 2_000_000_000n } : null)
  await f.service.reconcile()
}

describe('signing gate and duplicate recovery', () => {
  it('retains the nonce when a custom-token withdrawal passes the head trace but is excluded later', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    const data = await signedWithdrawalRequest(f.quote.id, f.sdk.publicViewingKey,
      Wallet.createRandom().address, Wallet.createRandom().address)
    const wire = await packetFor(data, f.sdk.publicViewingKey)
    f.provider.send.mockResolvedValue({ type: 'CALL', calls: [
      { type: 'CALL', to: NETWORK.proxyContract, input: privateCalldata(data) },
    ] })
    f.sender.broadcastTransaction.mockRejectedValue(new Error('Private builder: token execution reverted at target block'))
    expect(wire.decode(await f.service.handle(wire.payload)).error).toContain('Submission outcome is unknown')
    expect(f.provider.send).toHaveBeenCalled()
    expect(f.sdk.validate).toHaveBeenCalledOnce()
    expect(f.sign).toHaveBeenCalledOnce()
    expect(store.pending()).toHaveLength(1)
    const held = store.pending()[0]
    expect(held.raw).toBeTruthy()
    expect(held.nonce).toBe(0)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.quote.expiration + 60_000)
    try {
      await f.service.reconcile()
      expect(store.pending()[0].raw).toBe(held.raw)
      expect(store.exposure()).toBe(BigInt(held.max_cost))
      expect(await f.service.available()).toBe(false)
      expect(f.sdk.assure).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
  it.each([false, true])('repeats the trace after a same-height reorg and rejects an expired final head: %s', async (expires) => {
    const f = await fixture(Wallet.createRandom().address)
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    let heads = 0, traces = 0
    f.provider.getBlock.mockImplementation(async (tag?: string | number) => {
      if (tag === 'latest') heads++
      return { number: 100, hash: heads < 2 ? blockHash : `0x${'66'.repeat(32)}`,
        timestamp: Math.floor(now / 1000), baseFeePerGas: 1n }
    })
    const originalTrace = await f.provider.send()
    f.provider.send.mockImplementation(async () => {
      traces++
      if (expires && traces === 2) clock.mockReturnValue(now + 46_000)
      return originalTrace
    })
    try {
      const result = f.decode(await f.service.handle(f.payload))
      expect(traces).toBe(2)
      expect(f.sign).toHaveBeenCalledTimes(expires ? 0 : 1)
      if (expires) expect(result.error).toContain('signing')
      else expect(result.txHash).toBeTruthy()
    } finally { clock.mockRestore() }
  })
  it('permits one atomic USDC pilot withdrawal with its required fee asset, persists the one-time gate, and replays duplicates', async () => {
    const recipient = Wallet.createRandom().address
    const f = await fixture(Wallet.createRandom().address, recipient)
    f.service.config.pilotAccount = Wallet.createRandom().address
    const result = f.decode(await f.service.handle(f.payload))
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    const signed = Transaction.from(store.get((store.db.prepare('SELECT key FROM requests').get() as { key: string }).key)!.raw!)
    expect(signed.to).toBe(CHAIN_ID === 56 ? f.service.config.executionGuard : getAddress(NETWORK.proxyContract))
    expect(signed.type).toBe(CHAIN_ID === 56 ? 4 : COMMON_TRANSACTION_TYPE)
    const batch = CHAIN_ID === 56 ? ADAPT.decodeFunctionData('execute', decodeGuardedExecution(signed.data).execution)._transactions
      : PROXY.decodeFunctionData('transact', signed.data)._transactions
    expect(batch).toHaveLength(CHAIN_ID === 56 ? 2 : 1)
    expect(batch[batch.length - 1].unshieldPreimage.token.tokenAddress).toBe(TOKENS[1].address)
    if (CHAIN_ID === 56) {
      expect(BigInt(batch[0].boundParams.unshield)).toBe(0n)
      expect(JSON.parse(store.pending()[0].fee_data!).payment.token).toBe(TOKENS[0].address)
    }
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe(result.txHash)
    expect(await f.service.available()).toBe(false)
    expect(f.decode(await f.service.handle(f.payload))).toEqual(result)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.sdk.validate).toHaveBeenCalledOnce()
  })
  it('keeps the restricted pilot principal in USDC rather than selecting it from the fee asset', async () => {
    const recipient = Wallet.createRandom().address
    const f = await fixture(undefined, recipient)
    const data = await withdrawalRequest(f.quote.id, f.sdk.publicViewingKey, recipient, 1, 1, TOKENS[0].address)
    const wire = await packetFor(data, f.sdk.publicViewingKey)
    expect(wire.decode(await f.service.handle(wire.payload)).error).toContain('USDC withdrawal only')
    expect(f.sdk.fee).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it.runIf(CHAIN_ID === 56)('rejects a correctly bound USDT exit from the USDC-only pilot', async () => {
    const recipient = Wallet.createRandom().address
    const f = await fixture(Wallet.createRandom().address, recipient)
    const data = await signedWithdrawalRequest(f.quote.id, f.sdk.publicViewingKey, recipient, TOKENS[2].address)
    const wire = await packetFor(data, f.sdk.publicViewingKey)
    expect(wire.decode(await f.service.handle(wire.payload)).error).toContain('USDC withdrawal only')
    expect(f.sdk.fee).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it.runIf(CHAIN_ID === 56).each([false, true])('rejects a bound withdrawal if its exact net amount changes%s', async (duringValidation) => {
    const f = await fixture(Wallet.createRandom().address, Wallet.createRandom().address)
    const call = f.provider.call.getMockImplementation()!
    let fee = duringValidation ? 0n : 25n
    f.provider.call.mockImplementation(async (request) => request.data === PROXY.encodeFunctionData('unshieldFee')
      ? PROXY.encodeFunctionResult('unshieldFee', [fee]) : call(request))
    if (duringValidation) {
      const proof = await f.sdk.validate()
      f.sdk.validate.mockClear()
      f.sdk.validate.mockImplementationOnce(async () => { fee = 25n; return proof })
    }
    expect(f.decode(await f.service.handle(f.payload)).error).toContain('privacy contracts')
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it.each(['unconfigured', 'recipient', 'fee-token', 'underpaid', 'used'])('rejects an unsafe withdrawal pilot: %s', async (kind) => {
    const f = await fixture(undefined, Wallet.createRandom().address)
    if (kind === 'unconfigured') f.service.config.pilotWithdrawalRecipient = undefined
    if (kind === 'recipient') f.service.config.pilotWithdrawalRecipient = Wallet.createRandom().address
    if (kind === 'fee-token') f.sdk.fee.mockResolvedValue({ [TOKENS[CHAIN_ID === 56 ? 1 : 0].address]: 2_000_000_000_000_000n })
    if (kind === 'underpaid') f.sdk.fee.mockResolvedValue({ [TOKENS[CHAIN_ID === 56 ? 0 : 1].address]: 1n })
    if (kind === 'used') store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('withdrawalPilot', 'previous-hash')
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('prices a common withdrawal above the current base fee without changing its proof or fee', async () => {
    const f = await fixture(undefined, Wallet.createRandom().address, true)
    const minimum = BigInt(f.data.minGasPrice as string)
    f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: minimum })
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const row = store.pending()[0]
    const signed = Transaction.from(row.raw!)
    expect(signed.gasPrice).toBe(minimum + 1n)
    expect(signed.data).toBe(f.data.data)
    expect(BigInt(row.max_cost)).toBe(signed.gasLimit * (minimum + 1n))
    expect(f.sdk.fee).toHaveBeenCalledOnce()
  })
  it.runIf(CHAIN_ID === 56 || CHAIN_ID === 137)('prices COMMON withdrawals at their actual network minimum', async () => {
    const f = await fixture(undefined, Wallet.createRandom().address, true)
    f.provider.getFeeData.mockResolvedValue({ gasPrice: CHAIN_ID === 56 ? 3_000_000_000n : 12_000_000_000n,
      maxPriorityFeePerGas: 3_000_000_000n })
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const signed = Transaction.from(store.pending()[0].raw!)
    expect(signed.type).toBe(COMMON_TRANSACTION_TYPE)
    expect(signed.gasPrice).toBe(CHAIN_ID === 56 ? 3_000_000_000n : 3_000_000_001n)
  })
  it.runIf(CHAIN_ID === 56 || CHAIN_ID === 137)('rejects type-4 execution whose fee cap covers the network minimum but effective price does not', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.provider.getFeeData.mockResolvedValue({ gasPrice: 1_500_000_000n, maxPriorityFeePerGas: 1_500_000_000n })
    expect(f.decode(await f.service.handle(f.payload)).error).toContain('gas pricing')
    expect(f.sdk.validate).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it.runIf(CHAIN_ID === 56)('rechecks BNB effective gas price after a falling base fee during proof validation', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.provider.getFeeData.mockResolvedValue({ gasPrice: 1_500_000_000n, maxPriorityFeePerGas: 1n })
    f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash,
      timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 600_000_000n })
    const proof = await f.sdk.validate()
    f.sdk.validate.mockClear()
    f.sdk.validate.mockImplementationOnce(async () => {
      f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash,
        timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 400_000_000n })
      return proof
    })
    expect(f.decode(await f.service.handle(f.payload)).error).toContain('conditions changed')
    expect(f.sdk.validate).toHaveBeenCalledOnce()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it.each(['cap', 'payment'])('never signs a repriced withdrawal exceeding its %s', async (reason) => {
    const f = await fixture(undefined, Wallet.createRandom().address, true)
    const base = reason === 'cap' ? config.maxGasPrice : BigInt(f.data.minGasPrice as string)
    f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: base })
    if (reason === 'payment') f.sdk.fee.mockResolvedValue({ [TOKENS[CHAIN_ID === 56 ? 0 : 1].address]: 440_000n })
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('advertises remaining budget while retaining the exact per-request and journal spending gates', async () => {
    const f = await fixture()
    f.service.config.dailyBudget = f.service.config.maxTransactionCost
    store.signed('old', 'envelope', 'raw', 'oldhash', 1n, config.dailyBudget, 0)
    store.confirmed('old', 1n, Date.now())
    store.assured('old')
    f.provider.getTransactionCount.mockImplementation(async (address?: string) => address === f.service.wallet.address ? 1 : 0)
    expect(await f.service.available()).toBe(true)
    f.service.config.dailyBudget = 2n
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('halts new signing until a confirmed earlier request has its fee assured', async () => {
    const f = await fixture()
    store.signed('old', 'envelope', 'raw', 'oldhash', 1n, config.dailyBudget, 0)
    store.confirmed('old', 1n, Date.now())
    f.provider.getTransactionCount.mockImplementation(async (address?: string) => address === f.data.to ? 0 : 1)
    expect(await f.service.available()).toBe(false)
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sdk.fee).not.toHaveBeenCalled()
    store.assured('old')
    expect(await f.service.available()).toBe(true)
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('advertises fees with lowercase token keys for the RAILGUN client cache while preserving stored rates', async () => {
    const f = await fixture()
    const envelope = JSON.parse(Buffer.from(await f.service.feeAdvertisement()).toString())
    const advertisement = JSON.parse(Buffer.from(envelope.data, 'hex').toString())
    expect(advertisement.fees[TOKENS[0].address.toLowerCase()]).toBe('0xde0b6b3a7640000')
    expect(Object.keys(advertisement.fees).every((token) => token === token.toLowerCase())).toBe(true)
    const stored = store.db.prepare('SELECT rates FROM fees WHERE id=?').get(advertisement.feesID) as { rates: string }
    expect(JSON.parse(stored.rates)[getAddress(TOKENS[0].address)]).toBe('0xde0b6b3a7640000')
    expect(f.sdk.sign).toHaveBeenCalledWith(envelope.data)
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('rejects other accounts before proof work and signing during the restricted pilot', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.pilotAccount = Wallet.createRandom().address
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sdk.fee).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    f.service.config.pilotAccount = String(f.data.to)
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
  })
  it.runIf(CHAIN_ID === 56)('rejects unsecured BNB mainnet requests even with the approved pilot account', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.mode = 'mainnet'
    f.service.config.admission = 'public'
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sdk.fee).not.toHaveBeenCalled()
    expect(f.provider.getNetwork).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    f.service.config.admission = 'pilot'
    f.service.config.pilotAccount = Wallet.createRandom().address
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sdk.fee).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    f.service.config.pilotAccount = String(f.data.to)
    expect(f.decode(await f.service.handle(f.payload)).error).toContain('requires confirmed prepaid fees')
    expect(f.sdk.validate).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('wraps the exact fee-validated request without changing the user authorization or execution', async () => {
    const guard = Wallet.createRandom().address
    const f = await fixture(guard)
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const signed = Transaction.from(store.pending()[0].raw!)
    expect(signed.to).toBe(guard)
    expect(decodeGuardedExecution(signed.data)).toEqual({ account: f.data.to, execution: f.data.data, nonce: 0n })
    expect(f.sdk.validate).toHaveBeenCalledOnce()
    expect(f.provider.getCode).toHaveBeenCalledWith(guard, 100)
    expect(f.sender.broadcastTransaction).toHaveBeenCalledOnce()
  })
  it('refuses an unreviewed execution guard before signing', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.provider.getCode.mockResolvedValue('0x00')
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it.each(['missing', 'changed', 'removed-during-proof'])('attests the configured guard for COMMON withdrawals: %s', async (reason) => {
    const guard = Wallet.createRandom().address
    const f = await fixture(guard, Wallet.createRandom().address)
    if (reason === 'removed-during-proof') {
      const proof = await f.sdk.validate()
      f.sdk.validate.mockClear()
      f.sdk.validate.mockImplementationOnce(async () => { f.provider.getCode.mockResolvedValue('0x'); return proof })
    } else f.provider.getCode.mockResolvedValue(reason === 'missing' ? '0x' : '0x6002')
    expect(f.decode(await f.service.handle(f.payload)).error).toContain('privacy contracts')
    expect(f.provider.getCode).toHaveBeenCalledWith(guard, 100)
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    expect(store.pending()).toEqual([])
  })
  it('does not advertise availability when the current base fee exceeds the operator cap', async () => {
    const f = await fixture()
    f.provider.getBlock.mockResolvedValue({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: config.maxGasPrice })
    expect(await f.service.available()).toBe(false)
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('journals the request and raw transaction before private disclosure, then replays the response without signing again', async () => {
    const f = await fixture()
    let journaledBeforeSend = false
    f.sender.broadcastTransaction.mockImplementationOnce(async (raw, validUntilMs) => {
      const row = store.pending()[0]
      expect(validUntilMs).toBe(f.quote.expiration)
      expect(row.fee_expiration).toBe(validUntilMs)
      journaledBeforeSend = row?.raw === raw && row.fee_data.includes('test-commitment')
      return { hash: Transaction.from(raw).hash! }
    })
    const response = f.decode(await f.service.handle(f.payload))
    expect(response.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(journaledBeforeSend).toBe(true)
    expect(f.sdk.validate).toHaveBeenCalledOnce()
    expect(f.sign).toHaveBeenCalledOnce()
    const duplicate = Buffer.from(JSON.stringify({ ...f.packet, id: 99 }))
    expect(f.decode(await f.service.handle(duplicate))).toEqual(response)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.sender.broadcastTransaction).toHaveBeenCalledOnce()
  })
  it.each(['fee', 'proof', 'trace', 'nonce', 'budget'])('never signs when %s validation fails', async (kind) => {
    const f = await fixture()
    if (kind === 'fee') f.sdk.fee.mockResolvedValue({ [TOKENS[0].address]: 1n })
    if (kind === 'proof') f.sdk.validate.mockRejectedValue(new Error('secret private proof details'))
    if (kind === 'trace') f.provider.send.mockResolvedValue({ type: 'CALL', calls: [{ type: 'CALL', error: 'revert' }] } as { type: string })
    if (kind === 'nonce') f.provider.getTransactionCount.mockResolvedValue(1)
    if (kind === 'budget') store.signed('old', 'envelope', 'old-signed', 'hash', config.dailyBudget, config.dailyBudget, 0)
    const result = f.decode(await f.service.handle(f.payload))
    expect(result.error).toBeTruthy()
    expect(result.error).not.toContain('secret private')
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it('keeps an unknown submission locked and does not sign a replacement after restart', async () => {
    const f = await fixture()
    f.sender.broadcastTransaction.mockRejectedValueOnce(new Error('upstream error containing sensitive data'))
    const first = f.decode(await f.service.handle(f.payload))
    expect(first.error).toContain('outcome is unknown')
    expect(store.pending()[0].raw).toBeTruthy()
    expect(store.exposure()).toBeGreaterThan(0n)
    expect(f.decode(await f.service.handle(f.payload))).toEqual(first)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(await f.service.available()).toBe(false)
  })
  it('ignores an identical in-flight retry instead of sending an error that could beat the result', async () => {
    const f = await fixture()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    f.sdk.validate.mockImplementationOnce(async () => {
      await waiting
      return { railgunTxid: 'txid', utxoTreeIn: 0, commitment: 'commitment', notePublicKey: 'npk', pois: {} }
    })
    const first = f.service.handle(f.payload)
    await vi.waitFor(() => expect(f.sdk.validate).toHaveBeenCalledOnce())
    expect(await f.service.handle(f.payload)).toBeUndefined()
    release()
    expect(f.decode(await first).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it('rechecks the user authorization nonce after slow proof validation', async () => {
    const f = await fixture()
    let proofComplete = false
    f.sdk.validate.mockImplementationOnce(async () => {
      proofComplete = true
      return { railgunTxid: 'txid', utxoTreeIn: 0, commitment: 'commitment', notePublicKey: 'npk', pois: {} }
    })
    f.provider.getTransactionCount.mockImplementation(async (address?: string) =>
      proofComplete && address === f.data.to ? 1 : 0)
    expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.sign).not.toHaveBeenCalled()
  })
  it('rejects unpaid junk before EVM work without consuming the validated trade allowance', async () => {
    const f = await fixture()
    f.sdk.fee.mockResolvedValue({ [TOKENS[0].address]: 0n })
    for (let i = 0; i < 30; i++) expect(f.decode(await f.service.handle(f.payload)).error).toBeTruthy()
    expect(f.provider.estimateGas).not.toHaveBeenCalled()
    f.sdk.fee.mockResolvedValue({ [TOKENS[0].address]: 2_000_000_000_000_000n })
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })
})

describe('permissionless guarded principal admission', () => {
  const outputs = CHAIN_ID === 56 ? [false, true] : [false]
  async function publicWithdrawal(native: boolean) {
    const recipient = Wallet.createRandom().address, principalToken = native ? TOKENS[0].address : Wallet.createRandom().address
    const f = await fixture(Wallet.createRandom().address, recipient)
    f.service.config.admission = 'public'; f.service.config.pilotWithdrawalRecipient = undefined
    f.sdk.fee.mockResolvedValue({ [TOKENS[0].address]: 2_000_000_000_000_000n })
    const data = native ? await signedNativeWithdrawalRequest(f.quote.id, f.sdk.publicViewingKey, recipient)
      : await signedWithdrawalRequest(f.quote.id, f.sdk.publicViewingKey, recipient, principalToken)
    const wire = await packetFor(data, f.sdk.publicViewingKey)
    f.provider.send.mockResolvedValue({ type: 'CALL', to: NETWORK.proxyContract, input: privateCalldata(data) })
    return { ...f, ...wire, data, principalToken, recipient }
  }
  it.each(outputs)('admits an exact guarded withdrawal with only wrapped-native payment (native: %s)', async (native) => {
    const f = await publicWithdrawal(native)
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const record = store.pending()[0], signed = Transaction.from(record.raw!)
    expect(signed.to).toBe(f.service.config.executionGuard)
    expect(decodeGuardedExecution(signed.data).execution).toBe(f.data.data)
    expect(JSON.parse(record.fee_data!).payment.token).toBe(TOKENS[0].address)
    expect(f.sign).toHaveBeenCalledOnce()
  })
  it.each(outputs)('never accepts the principal as a replacement fee asset (native: %s)', async (native) => {
    const f = await publicWithdrawal(native)
    f.sdk.fee.mockResolvedValue({ [native ? TOKENS[1].address : f.principalToken]: 2_000_000_000_000_000n })
    expect(f.decode(await f.service.handle(f.payload)).error).toContain(TOKENS[0].symbol)
    expect(f.sign).not.toHaveBeenCalled(); expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
  it.each(outputs)('preserves the USDC-only restricted pilot (native: %s)', async (native) => {
    const f = await publicWithdrawal(native)
    f.service.config.admission = 'pilot'
    f.service.config.pilotWithdrawalRecipient = f.recipient
    expect(f.decode(await f.service.handle(f.payload)).error).toContain('USDC withdrawal only')
    expect(f.sdk.fee).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled()
  })
  it.each(['0x', '0x0', 'not-code'])('rejects an unqualified principal contract response: %s', async (code) => {
    const f = await publicWithdrawal(false), original = f.provider.getCode.getMockImplementation()!
    f.provider.getCode.mockImplementation(async (address) => address === f.principalToken ? code : original(address))
    expect(f.decode(await f.service.handle(f.payload)).error).toContain('could not verify')
    expect(f.provider.send).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled()
  })
  it.each(outputs)('blocks an untrusted token or native-recipient failure in the execution trace (native: %s)', async (native) => {
    const f = await publicWithdrawal(native)
    f.provider.send.mockResolvedValue({ type: 'CALL', calls: [
      { type: 'CALL', to: NETWORK.proxyContract, input: privateCalldata(f.data) },
      { type: 'CALL', to: f.principalToken, error: 'execution reverted', output: '0x' },
    ] })
    expect(f.decode(await f.service.handle(f.payload)).error).toContain('exact execution trace')
    expect(f.sign).not.toHaveBeenCalled(); expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    expect(store.hasPending()).toBe(false)
  })
  it.runIf(CHAIN_ID === 56)('checks native unwrap/send against the current exact net unshield amount before signing', async () => {
    const f = await publicWithdrawal(true), original = f.provider.call.getMockImplementation()!
    f.provider.call.mockImplementation(async (tx) => tx.data === PROXY.encodeFunctionData('unshieldFee')
      ? PROXY.encodeFunctionResult('unshieldFee', [25n]) : original(tx))
    expect(f.decode(await f.service.handle(f.payload)).error).toContain('could not verify')
    expect(f.sign).not.toHaveBeenCalled(); expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  })
})

describe('public admission and sequential settlement', () => {
  it.each(['unsettled', 'orphaned'])('resolves an earlier mined cancellation when the newest replacement is %s', async (newest) => {
    const f = await fixture(Wallet.createRandom().address)
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const record = store.pending()[0]
    const first = `0x${'aa'.repeat(32)}`, second = `0x${'bb'.repeat(32)}`
    store.cancel(record.key, 'first-saved-cancellation', first, 1n, config.dailyBudget)
    store.cancel(record.key, 'replacement-cancellation', second, 1n, config.dailyBudget)
    f.provider.getTransactionCount.mockResolvedValue(1)
    f.provider.getTransactionReceipt.mockImplementation(async (hash?: string) => hash === first
      ? { status: 1, blockNumber: 99, blockHash, gasUsed: 21_000n, gasPrice: 2_000_000_000n }
      : hash === second ? { status: 1, blockNumber: newest === 'unsettled' ? 101 : 99,
        blockHash: `0x${'66'.repeat(32)}`, gasUsed: 21_000n, gasPrice: 3_000_000_000n } : null)
    await f.service.reconcile()
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledWith(second)
    expect(f.provider.getTransactionReceipt).toHaveBeenCalledWith(first)
    expect(store.hasPending()).toBe(false)
    expect(store.get(record.key)?.actual_cost).toBe((21_000n * 2_000_000_000n).toString())
    expect(store.get(record.key)?.cancel_hash).toBe(second)
    expect(f.sdk.assure).not.toHaveBeenCalled()
  })
  it.each(['unsettled', 'orphaned'])('retains the halt when the only cancellation receipt is %s', async (reason) => {
    const f = await fixture(Wallet.createRandom().address)
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const record = store.pending()[0], cancellation = `0x${'aa'.repeat(32)}`
    store.cancel(record.key, 'saved-cancellation', cancellation, 1n, config.dailyBudget)
    f.provider.getTransactionCount.mockResolvedValue(1)
    f.provider.getTransactionReceipt.mockImplementation(async (hash?: string) => hash === cancellation
      ? { status: 1, blockNumber: reason === 'unsettled' ? 101 : 99, blockHash: `0x${'66'.repeat(32)}`,
        gasUsed: 21_000n, gasPrice: 2_000_000_000n } : null)
    await f.service.reconcile()
    expect(store.hasPending()).toBe(true)
    expect(store.get(record.key)?.assured).toBe(0)
  })
  it('resolves an explicit confirmed cancellation without claiming a private fee was delivered', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    expect(f.decode(await f.service.handle(f.payload)).txHash).toBeTruthy()
    const record = store.pending()[0], cancelHash = `0x${'ab'.repeat(32)}`
    store.cancel(record.key, 'saved-cancellation', cancelHash, 1n, config.dailyBudget)
    f.provider.getTransactionCount.mockResolvedValue(1)
    f.provider.getTransactionReceipt.mockImplementation(async (hash?: string) => hash === cancelHash
      ? { status: 1, blockNumber: 99, blockHash, gasUsed: 21_000n, gasPrice: 2_000_000_000n } : null)
    await f.service.reconcile()
    expect(store.hasPending()).toBe(false)
    expect(await f.service.available()).toBe(true)
    expect(f.sdk.assure).not.toHaveBeenCalled()
    expect(store.get(record.key)?.actual_cost).toBe((21_000n * 2_000_000_000n).toString())
    expect(store.get(record.key)?.cancel_hash).toBe(cancelHash)
    f.provider.getTransactionCount.mockResolvedValue(0)
    f.provider.getTransactionReceipt.mockResolvedValue(null)
    await f.service.reconcile()
    expect(await f.service.available()).toBe(false)
    expect(f.sign).toHaveBeenCalledOnce()
    expect(store.get(record.key)?.cancel_hash).toBe(cancelHash)
  })
  it.each(TOKENS)('permits repeated $symbol withdrawals with the required fee asset and preserves a used pilot marker', async (token) => {
    const f = await fixture(Wallet.createRandom().address, Wallet.createRandom().address)
    f.service.config.admission = 'public'
    f.service.config.pilotWithdrawalRecipient = undefined
    store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('withdrawalPilot', 'historical-pilot-hash')
    for (let nonce = 0; nonce < 2; nonce++) {
      const nullifier = `0x${(nonce + 1).toString(16).padStart(64, '0')}`
      const data = CHAIN_ID === 56 && token.address !== TOKENS[0].address
        ? await signedWithdrawalRequest(f.quote.id, f.sdk.publicViewingKey, Wallet.createRandom().address, token.address, nullifier)
        : await withdrawalRequest(f.quote.id, f.sdk.publicViewingKey, Wallet.createRandom().address, 1, 1, token.address, nullifier)
      const wire = await packetFor(data, f.sdk.publicViewingKey)
      f.sdk.fee.mockResolvedValue({ [getAddress(CHAIN_ID === 56 ? TOKENS[0].address : token.address)]:
        CHAIN_ID === 56 || token.address === TOKENS[0].address ? 2_000_000_000_000_000n : 2_000_000n })
      f.provider.send.mockResolvedValue({ type: 'CALL', to: NETWORK.proxyContract, input: privateCalldata(data) })
      const response = wire.decode(await f.service.handle(wire.payload))
      expect(response.txHash).toBeTruthy()
      const signed = Transaction.from(store.pending()[0].raw!)
      expect(signed.nonce).toBe(nonce)
      expect(signed.to).toBe(data.transactType === 'TX7702' ? f.service.config.executionGuard : getAddress(NETWORK.proxyContract))
      expect(await f.service.available()).toBe(false)
      await confirm(f, response.txHash!)
      expect(store.hasPending()).toBe(false)
      expect(await f.service.available()).toBe(true)
      expect(wire.decode(await f.service.handle(wire.payload))).toEqual(response)
    }
    expect(f.sign).toHaveBeenCalledTimes(2)
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe('historical-pilot-hash')
    f.service.config.admission = 'pilot'
    f.service.config.pilotWithdrawalRecipient = Wallet.createRandom().address
    expect(await f.service.available()).toBe(false)
  })

  it('serves unrelated swap accounts sequentially without replacing the operator or signing duplicates', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    const accounts = new Set<string>()
    for (let nonce = 0; nonce < 2; nonce++) {
      const data = await privateRequest(f.quote.id, f.sdk.publicViewingKey, `0x${(nonce + 1).toString(16).padStart(64, '0')}`)
      accounts.add(String(data.to))
      const wire = await packetFor(data, f.sdk.publicViewingKey)
      f.provider.send.mockResolvedValue({ type: 'CALL', to: NETWORK.proxyContract,
        input: PROXY.encodeFunctionData('transact', [ADAPT.decodeFunctionData('execute', String(data.data))._transactions]) })
      const response = wire.decode(await f.service.handle(wire.payload))
      expect(response.txHash).toBeTruthy()
      const tx = Transaction.from(store.pending()[0].raw!)
      expect(tx.from).toBe(f.service.wallet.address)
      expect(tx.nonce).toBe(nonce)
      expect(decodeGuardedExecution(tx.data).account).toBe(data.to)
      await confirm(f, response.txHash!)
      expect(wire.decode(await f.service.handle(Buffer.from(JSON.stringify({ ...wire.packet, id: 99 }))))).toEqual(response)
    }
    expect(accounts.size).toBe(2)
    expect(f.sign).toHaveBeenCalledTimes(2)
    expect(f.sender.broadcastTransaction).toHaveBeenCalledTimes(2)
  })

  it.each(['zero-recipient', 'high-recipient', 'token', 'zero-amount', 'nft', 'sub-id', 'fee-token', 'underpaid', 'expired'])('rejects an unsafe public withdrawal before signing: %s', async (kind) => {
    const f = await fixture(undefined, Wallet.createRandom().address)
    f.service.config.admission = 'public'
    f.service.config.pilotWithdrawalRecipient = undefined
    const recipient = kind === 'zero-recipient' ? ZeroAddress : kind === 'high-recipient'
      ? `0x01${Wallet.createRandom().address.slice(2)}` : Wallet.createRandom().address
    const data = await withdrawalRequest(f.quote.id, f.sdk.publicViewingKey, recipient, 1, 1,
      kind === 'token' ? Wallet.createRandom().address : TOKENS[CHAIN_ID === 56 ? 0 : 1].address)
    if (['zero-amount', 'nft', 'sub-id'].includes(kind)) {
      const batch = Array.from(PROXY.decodeFunctionData('transact', String(data.data))._transactions)
      const transaction = (batch[batch.length - 1] as { toObject(): Record<string, any> }).toObject()
      transaction.unshieldPreimage = transaction.unshieldPreimage.toObject()
      transaction.unshieldPreimage.token = transaction.unshieldPreimage.token.toObject()
      if (kind === 'zero-amount') transaction.unshieldPreimage.value = 0n
      if (kind === 'nft') transaction.unshieldPreimage.token.tokenType = 1n
      if (kind === 'sub-id') transaction.unshieldPreimage.token.tokenSubID = 1n
      batch[batch.length - 1] = transaction
      data.data = PROXY.encodeFunctionData('transact', [batch])
    }
    if (kind === 'fee-token') f.sdk.fee.mockResolvedValue({ [TOKENS[CHAIN_ID === 56 ? 1 : 0].address]: 2_000_000_000_000_000n })
    if (kind === 'underpaid') f.sdk.fee.mockResolvedValue({ [TOKENS[CHAIN_ID === 56 ? 0 : 1].address]: 1n })
    if (kind === 'expired') store.db.prepare('UPDATE fees SET expiration=0 WHERE id=?').run(f.quote.id)
    f.provider.send.mockResolvedValue({ type: 'CALL', to: NETWORK.proxyContract, input: data.data })
    const wire = await packetFor(data, f.sdk.publicViewingKey)
    const error = wire.decode(await f.service.handle(wire.payload)).error
    const expected = ['zero-recipient', 'high-recipient'].includes(kind) ? 'nonzero public address'
      : ['token', 'zero-amount', 'nft', 'sub-id'].includes(kind) ? (CHAIN_ID === 56 ? 'request format' : 'supported fee token')
      : kind === 'fee-token' ? (CHAIN_ID === 56 ? 'WBNB' : 'withdrawn token') : kind === 'expired' ? 'fee quote expired' : 'does not cover execution'
    expect(error).toContain(expected)
    expect(f.sdk.validate).not.toHaveBeenCalled()
    if (!['fee-token', 'underpaid'].includes(kind)) expect(f.sdk.fee).not.toHaveBeenCalled()
    if (kind !== 'underpaid') expect(f.provider.send).not.toHaveBeenCalled()
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    expect(store.hasPending()).toBe(false)
  })

  it('rejects another user while validation is in progress without consuming a second signature', async () => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const proof = await f.sdk.validate()
    f.sdk.validate.mockImplementationOnce(async () => { await waiting; return proof })
    f.sdk.validate.mockClear()
    const first = f.service.handle(f.payload)
    await vi.waitFor(() => expect(f.sdk.validate).toHaveBeenCalledOnce())
    const other = await packetFor(await privateRequest(f.quote.id, f.sdk.publicViewingKey, `0x${'13'.repeat(32)}`), f.sdk.publicViewingKey)
    expect(other.decode(await f.service.handle(other.payload)).error).toContain('finishing another transaction')
    expect(f.sign).not.toHaveBeenCalled()
    release()
    expect(f.decode(await first).txHash).toBeTruthy()
    expect(f.sign).toHaveBeenCalledOnce()
  })

  it('preserves recorded gas expense when a confirmed receipt temporarily disappears', async () => {
    const f = await fixture(Wallet.createRandom().address)
    const result = f.decode(await f.service.handle(f.payload))
    const saved = store.pending()[0]
    f.sdk.assure.mockResolvedValue(false)
    await confirm(f, result.txHash!)
    const recorded = store.get(saved.key)!
    expect(recorded.confirmed).toBe(1)
    expect(recorded.actual_cost).toBe((100_000n * 2_000_000_000n).toString())
    f.provider.getTransactionReceipt.mockResolvedValue(null)
    await f.service.reconcile()
    expect(store.get(saved.key)?.actual_cost).toBe(recorded.actual_cost)
    expect(store.get(saved.key)?.mined_at).toBe(recorded.mined_at)
    expect(store.get(saved.key)?.assured).toBe(0)
    expect(store.hasPending()).toBe(true)
  })

  it.each(['unknown-submission', 'missing-fee', 'included-revert', 'unknown-nonce'])('preserves the halt across restart for %s', async (reason) => {
    const f = await fixture(Wallet.createRandom().address)
    f.service.config.admission = 'public'
    if (reason === 'unknown-submission') f.sender.broadcastTransaction.mockRejectedValueOnce(new Error('unknown'))
    const first = f.decode(await f.service.handle(f.payload))
    const saved = store.pending()[0]
    store.close(); store = new Store(directory)
    f.service = new Broadcaster(f.service.config, store, f.sdk, f.service.provider, f.service.wallet, f.sender, { rates: async () => f.rates })
    expect(f.decode(await f.service.handle(f.payload))).toEqual(first)
    expect(await f.service.available()).toBe(false)
    expect(store.hasPending()).toBe(true)
    f.sdk.assure.mockResolvedValue(false)
    if (reason === 'missing-fee' || reason === 'included-revert') await confirm(f, saved.hash!, reason === 'included-revert' ? 0 : 1)
    if (reason === 'unknown-nonce') {
      f.provider.getTransactionCount.mockResolvedValue(1)
      await f.service.reconcile()
    }
    expect(await f.service.available()).toBe(false)
    expect(store.get(saved.key)?.raw).toBe(saved.raw)
    expect(store.get(saved.key)?.assured).toBe(0)
    const other = await packetFor(await privateRequest(f.quote.id, f.sdk.publicViewingKey, `0x${'13'.repeat(32)}`), f.sdk.publicViewingKey)
    expect(other.decode(await f.service.handle(other.payload)).error).toContain('finishing another transaction')
    expect(f.sign).toHaveBeenCalledOnce()
    expect(f.sender.broadcastTransaction).toHaveBeenCalledOnce()
    if (reason === 'missing-fee') {
      f.sdk.assure.mockResolvedValue(true)
      await f.service.reconcile()
      expect(await f.service.available()).toBe(true)
    }
    if (reason === 'included-revert') {
      f.sdk.assure.mockResolvedValue(true)
      await f.service.reconcile()
      expect(await f.service.available()).toBe(false)
    }
    if (reason === 'unknown-nonce') {
      f.sdk.assure.mockResolvedValue(true)
      await f.service.reconcile()
      expect(f.sdk.assure).not.toHaveBeenCalled()
      expect(store.get(saved.key)?.assured).toBe(0)
      expect(await f.service.available()).toBe(false)
    }
  })
})
