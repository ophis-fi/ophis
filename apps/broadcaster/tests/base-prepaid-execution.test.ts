import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ed from '@noble/ed25519'
import { encryptDataWithSharedKey, tryDecryptJSONDataWithSharedKey } from '@railgun-community/wallet'
import { AbiCoder, id, Interface, toBeHex, toQuantity, Transaction, Wallet, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { RelayAdapt7702ExecutionType, RelayAdapt7702Helper, signExecutionAuthorization, type TransactionStructV2 } from '@railgun-community/engine'
import { createBaseValidityBody, prepareBaseValidity, validateBaseValidityPlan, type BaseValidityPlan } from '../../railgun/operator/base-validity'
import { decodeGuardedExecution, executionGuardCode } from '../../railgun/operator/execution-guard'
import type { Store } from '../src/storage'

let store: Store | undefined, directory: string
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '8453')
  directory = mkdtempSync(join(tmpdir(), 'ophis-base-prepaid-'))
})
afterEach(() => {
  store?.close(); store = undefined
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules()
})

async function fixture() {
  const [{ Store }, { Broadcaster }, { CreditLedger, creditCharge }, { config }, { ADAPT, PROXY },
    { CHAIN, CHAIN_ID, NETWORK, VERSION }, protocol, { recover }] = await Promise.all([
    import('../src/storage'), import('../src/broadcaster'), import('../src/credit'), import('./request.fixture'),
    import('../src/transaction'), import('../src/config'), import('../../railgun/credit-protocol'), import('../src/recovery'),
  ])
  expect(CHAIN_ID).toBe(8453)
  const journal = store = new Store(directory), wallet = new Wallet(Wallet.createRandom().privateKey), owner = Wallet.createRandom()
  journal.bindIdentity(CHAIN_ID, wallet.address)
  const guard = Wallet.createRandom().address, delegateCode = '0x6001'
  const delegations = new Map<string, string>()
  const settings = { ...config, executionGuard: guard, admission: 'public' as const, creditPaymentMode: 'public-native' as const }
  const deposit = 10n ** 18n, state = { head: 100, finalized: 99, nonce: 0, balance: deposit + settings.reserve }
  const changed = new Map<number, string>(), receipts = new Map<string, TransactionReceipt>()
  const transactions = new Map<string, Record<string, unknown>>()
  const block = (number: number) => ({ number, hash: changed.get(number) ?? id(`pipeline block ${number}`),
    timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n })
  const l1 = '0x4200000000000000000000000000000000000015', oracle = '0x420000000000000000000000000000000000000f'
  const impl = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
  const words = new Map([
    [`${l1}:0x1`, 1_000_000_000n], [`${l1}:0x3`, (1000n << 96n) | (1000n << 64n) | 99n],
    [`${l1}:0x7`, 1n], [`${l1}:0x8`, (7n << 64n) | 9n],
    [`${l1}:${impl}`, 0x8bde8f549f56d405f07e1aa15df9e1fc69839881n],
    [`${oracle}:${impl}`, 0x4f1db3c6abd250ba86e0928471a8f7db3afd88f1n], [`${oracle}:0x0`, 0x01010101n],
  ])
  const extraFees = new Map<string, { l1: bigint; operator: bigint }>()
  const registry = new Interface(['function getContractAddress(string name) view returns (address)'])
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: CHAIN })),
    getBlock: vi.fn(async (tag: string | number) => block(tag === 'latest' ? state.head : tag === 'finalized' ? state.finalized : Number(tag))),
    getTransactionCount: vi.fn(async (address: string, tag: string | number) => {
      if (address !== wallet.address) return 0
      if (tag === 'finalized' || typeof tag === 'number' && tag <= state.finalized)
        return [...receipts.values()].filter(receipt => receipt.from === wallet.address && receipt.blockNumber <= state.finalized).length
      return state.nonce
    }),
    getTransactionReceipt: vi.fn(async (hash: string) => receipts.get(hash) ?? null),
    getTransaction: vi.fn(async (hash: string) => transactions.get(hash) ?? null),
    getBalance: vi.fn(async () => state.balance),
    getCode: vi.fn(async (address: string) => address === wallet.address ? '0x' : address === guard
      ? executionGuardCode(wallet.address, delegateCode, NETWORK.relayAdapt7702Contract)
      : delegations.get(address) ?? delegateCode),
    getFeeData: vi.fn(async () => ({ gasPrice: 2n, maxPriorityFeePerGas: 1n })),
    estimateGas: vi.fn(async (tx: { to?: string }) => tx.to === wallet.address ? 21_000n : 100_000n), getRpcTransaction: vi.fn(value => value),
    call: vi.fn(async (tx: { data: string }) => {
      if (tx.data.startsWith(registry.getFunction('getContractAddress')!.selector))
        return registry.encodeFunctionResult('getContractAddress', [NETWORK.relayAdapt7702Contract])
      if (tx.data === ADAPT.encodeFunctionData('adaptImplementation'))
        return ADAPT.encodeFunctionResult('adaptImplementation', [NETWORK.relayAdapt7702Contract])
      return ADAPT.encodeFunctionResult('nonce', [0n])
    }),
    send: vi.fn(async (method: string, params: any[]): Promise<unknown> => {
      if (method === 'eth_getStorageAt') return toBeHex(words.get(`${params[0]}:${params[1]}`)!, 32)
      if (method === 'eth_getTransactionReceipt') {
        const receipt = receipts.get(params[0])
        return receipt ? { transactionHash: receipt.hash, blockHash: receipt.blockHash, blockNumber: toQuantity(receipt.blockNumber),
          status: toQuantity(receipt.status!), gasUsed: toQuantity(receipt.gasUsed), effectiveGasPrice: toQuantity(receipt.gasPrice),
          l1Fee: toQuantity(extraFees.get(receipt.hash)?.l1 ?? 1_600_000_000n) } : null
      }
      if (method === 'eth_call') {
        expect(params[1].requireCanonical).toBe(true)
        const receipt = [...receipts.values()].find(receipt => receipt.blockHash === params[1].blockHash)!
        return toBeHex(extraFees.get(receipt.hash)?.operator ?? (receipt.gasUsed * 700n + 9n), 32)
      }
      if (method !== 'debug_traceCall') throw new Error(`Unexpected mock RPC ${method}`)
      const tx = params[0]
      return tx.data === '0x' ? { type: 'CALL', from: tx.from, to: tx.to, input: '0x', value: toQuantity(tx.value) }
        : { type: 'CALL', calls: [{ type: 'CALL', to: NETWORK.proxyContract,
          input: PROXY.encodeFunctionData('transact', [ADAPT.decodeFunctionData('execute', decodeGuardedExecution(tx.data).execution)._transactions]) }] }
    }),
  }
  const privateViewingKey = randomBytes(32), publicViewingKey = Buffer.from(await ed.getPublicKey(privateViewingKey)).toString('hex')
  const sdk = { address: '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f',
    privateViewingKey, publicViewingKey, ready: () => true, sign: vi.fn(async () => 'signature'), fee: vi.fn(async () => ({})),
    validate: vi.fn(async () => ({ railgunTxid: 'test-txid', utxoTreeIn: 0, commitment: 'test-commitment', notePublicKey: 'test-npk', pois: {} })),
    validatePrepaid: vi.fn(async () => {}), assure: vi.fn(async () => true) }
  let pointer: { hash: string; nonce: number } | undefined
  const stage = (raw: string, plan: BaseValidityPlan) => { createBaseValidityBody(raw, plan); const tx = Transaction.from(raw); pointer = { hash: tx.hash!, nonce: tx.nonce }; return tx.hash! }
  const sender = { broadcastTransaction: vi.fn(async (raw: string, _expiry: number, plan: BaseValidityPlan) => ({ hash: stage(raw, plan) })),
    pendingTransaction: vi.fn(() => pointer), stageSigned: vi.fn(async (raw: string, plan: BaseValidityPlan) => stage(raw, plan)),
    stageRecovery: vi.fn(async (raw: string, _previous: { hash: string; nonce: number }, plan: BaseValidityPlan) => stage(raw, plan)),
    retryPending: vi.fn(async () => pointer!.hash), cancelPending: vi.fn(async (raw: string, plan: BaseValidityPlan) => { createBaseValidityBody(raw, plan); return Transaction.from(raw).hash! }) }
  const reserveOriginal = CreditLedger.prototype.reserve, reserve = vi.spyOn(CreditLedger.prototype, 'reserve')
  const sign = vi.spyOn(wallet, 'signTransaction'), rpc = provider as unknown as JsonRpcProvider
  const create = () => new Broadcaster(settings, journal, sdk, rpc, wallet, sender as never, { rates: async () => ({}) })
  let broadcaster = create()
  const info = await broadcaster.creditInfo(), ledger = CreditLedger.load(journal)
  async function send(payload: Record<string, unknown>) {
    const encoded = JSON.stringify(payload), expires = Date.now() + 240_000
    const signature = await owner.signTypedData(protocol.creditDomain(info.scope, info.ledgerId), protocol.CREDIT_AUTHORIZATION_TYPES,
      protocol.creditAuthorizationValue(info.scope, owner.address, encoded, expires))
    const encrypted = await encryptDataWithSharedKey({ protocol: protocol.CREDIT_PROTOCOL, correlation: id(encoded), broadcasterViewingKey: publicViewingKey,
      authorization: { owner: owner.address, payload: encoded, expires, signature } }, Buffer.from(publicViewingKey, 'hex'))
    const response = await broadcaster.handle(Buffer.from(JSON.stringify({ method: 'transact', id: 1,
      params: { pubkey: encrypted.randomPubKey, encryptedData: encrypted.encryptedData } })))
    expect(response).toBeDefined()
    return tryDecryptJSONDataWithSharedKey(JSON.parse(Buffer.from(response!).toString()).result, encrypted.sharedKey) as Record<string, any>
  }
  const paymentId = id('pipeline funding id'), transactionHash = id('pipeline funding'), payer = Wallet.createRandom().address, fundingBlock = block(90)
  transactions.set(transactionHash, { hash: transactionHash, from: payer, to: wallet.address, value: deposit, type: 2, chainId: CHAIN,
    data: protocol.nativeCreditData(info.scope, info.ledgerId, owner.address, paymentId), blockNumber: 90, blockHash: fundingBlock.hash })
  receipts.set(transactionHash, { hash: transactionHash, from: payer, to: wallet.address, blockNumber: 90,
    blockHash: fundingBlock.hash, status: 1, gasUsed: 22_000n, gasPrice: 1n } as TransactionReceipt)
  expect((await send({ kind: 'claim', transactionHash, paymentId })).available).toBe(deposit.toString())
  const quote = await send({ kind: 'quote' })
  expect(quote.kind).toBe('quote')
  async function privateRequest() {
    const account = Wallet.createRandom(), type = PROXY.getFunction('transact')!.inputs[0].arrayChildren!
    const tx = Array.from(AbiCoder.defaultAbiCoder().getDefaultValue([type])[0])
    tx[type.components!.findIndex(field => field.name === 'nullifiers')] = [id(`base nullifier ${ledger.nextSequence(owner.address)}`)]
    tx[type.components!.findIndex(field => field.name === 'commitments')] = [id('base commitment')]
    const index = type.components!.findIndex(field => field.name === 'boundParams'), bound = Array.from(tx[index] as unknown[])
    bound[type.components![index].components!.findIndex(field => field.name === 'chainID')] = CHAIN_ID
    bound[type.components![index].components!.findIndex(field => field.name === 'adaptContract')] = account.address
    tx[index] = bound
    const transactions = [tx as unknown as TransactionStructV2], action = RelayAdapt7702Helper.getActionData(false, [], 0n)
    const signature = await signExecutionAuthorization(account, transactions, action, CHAIN_ID,
      { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n })
    delegations.set(account.address, `0xef0100${NETWORK.relayAdapt7702Contract.slice(2).toLowerCase()}`)
    return { txidVersion: VERSION, chainType: 0, chainID: CHAIN_ID,
      minVersion: '8.0.0', maxVersion: '8.999.0', feesID: quote.feesID, broadcasterViewingKey: publicViewingKey,
      transactType: 'TX7702', useRelayAdapt: true, predelegated: true, to: account.address,
      data: ADAPT.encodeFunctionData('execute', [transactions, action, 0n, signature]),
      gasLimit: '1000000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000', preTransactionPOIsPerTxidLeafPerList: {} }
  }
  const execution = async () => ({ kind: 'execute', sequence: ledger.nextSequence(owner.address), request: await privateRequest(),
    maximumCharge: quote.maximumCharge, collectionAllowance: quote.collectionAllowance })
  const execute = async () => {
    const response = await send(await execution())
    expect(response.error).toBeUndefined()
    return journal.get(response.key)!
  }
  const include = (raw: string, status = 1) => {
    const tx = Transaction.from(raw), included = block(++state.head), gasUsed = tx.to === wallet.address ? 21_000n : 50_000n,
      gasPrice = tx.maxFeePerGas ?? tx.gasPrice!
    const l1Fee = 1_600_000_000n, operatorFee = gasUsed * 700n + 9n
    const cost = gasUsed * gasPrice + l1Fee + operatorFee
    extraFees.set(tx.hash!, { l1: l1Fee, operator: operatorFee })
    const receipt = { hash: tx.hash!, from: tx.from!, to: tx.to, blockNumber: included.number,
      blockHash: included.hash, status, gasUsed, gasPrice } as TransactionReceipt
    receipts.set(tx.hash!, receipt); state.nonce = tx.nonce + 1; state.balance -= cost + (status === 1 ? tx.value : 0n)
    return { receipt, cost }
  }
  return { journal, ledger, owner, wallet, deposit, settings, state, provider, rpc, receipts, changed, quote, sender, sign, reserve, reserveOriginal, words, l1, guard, delegations, extraFees,
    get broadcaster() { return broadcaster }, send, execution, execute, include, creditCharge,
    restart: async () => { broadcaster = create(); await broadcaster.creditInfo() },
    retry: () => recover('retry', [], settings, journal, rpc, wallet, sender as never),
    cancel: (price = '3000000000', tip = '2000000000') => recover('cancel', [price, tip], settings, journal, rpc, wallet, sender as never) }
}

it.each(['success', 'revert', 'refund', 'refund-revert'])('settles Base %s with all network fees and retains complete holds through finality', async kind => {
  const f = await fixture()
  let first
  if (kind.startsWith('refund')) {
    const quote = await f.send({ kind: 'quote', refund: true }), net = 10n ** 15n
    const response = await f.send({ kind: 'refund', sequence: quote.nextSequence, recipient: Wallet.createRandom().address,
      gross: (net + BigInt(quote.maximumCharge)).toString(), net: net.toString(), feesID: quote.feesID,
      collectionAllowance: '0', refundGasAllowance: quote.refundGasAllowance })
    expect(response.error).toBeUndefined(); first = f.journal.get(response.key)!
  } else first = await f.execute()
  const tx = Transaction.from(first.raw!), plan = f.ledger.baseValidity(first.key)!
  expect(tx.type).toBe(2)
  expect(tx.authorizationList).toBeNull()
  expect(plan.unsigned).toBe(tx.unsignedSerialized)
  expect(BigInt(first.max_cost)).toBe(BigInt(plan.maximumCost))
  expect(BigInt(first.max_cost)).toBeGreaterThan(tx.gasLimit * tx.maxFeePerGas!)
  if (!kind.startsWith('refund')) {
    expect(tx.to).toBe(f.guard)
    expect(f.delegations.has(decodeGuardedExecution(tx.data).account)).toBe(true)
  }
  expect(f.sender.broadcastTransaction).toHaveBeenLastCalledWith(first.raw, first.fee_expiration, plan)
  const firstIncluded = f.include(first.raw!, kind.endsWith('revert') ? 0 : 1)
  await f.broadcaster.reconcile()
  const firstMaximum = BigInt(f.ledger.attempt(first.key)!.maximum_charge)
  expect(f.ledger.balance(f.owner.address)).toMatchObject({ available: f.deposit - firstMaximum, reserved: firstMaximum, charged: 0n, refunds: 0n })
  expect(f.ledger.earned()).toBe(0n)
  expect(await f.broadcaster.available()).toBe(true)
  const second = await f.execute(), secondIncluded = f.include(second.raw!)
  await f.broadcaster.reconcile()
  const maximum = firstMaximum + BigInt(f.ledger.attempt(second.key)!.maximum_charge)
  expect(f.ledger.balance(f.owner.address)).toMatchObject({ available: f.deposit - maximum, reserved: maximum, charged: 0n })
  expect(f.journal.exposure()).toBe(BigInt(first.max_cost) + BigInt(second.max_cost))
  await f.restart()
  expect(await f.broadcaster.available()).toBe(true)
  expect(f.ledger.baseValidity(first.key)).toEqual(plan)
  f.state.finalized = f.state.head
  await f.broadcaster.reconcile()
  const fees = f.creditCharge(firstIncluded.cost, BigInt(f.quote.rate), 0n) + f.creditCharge(secondIncluded.cost, BigInt(f.quote.rate), 0n)
  const paid = kind === 'refund' ? tx.value : 0n
  expect(f.ledger.balance(f.owner.address)).toMatchObject({ reserved: 0n, charged: fees, refunds: paid, available: f.deposit - fees - paid })
  expect(f.ledger.earned()).toBe(fees - firstIncluded.cost - secondIncluded.cost)
  expect(f.sign).toHaveBeenCalledTimes(2)
})

it.each(['missing', 'undercharged', 'changed-predicate'])('rejects a %s Base plan atomically before any signature', async mutation => {
  const f = await fixture()
  f.reserve.mockImplementationOnce(attempt => {
    const changed = { ...attempt, baseValidity: attempt.baseValidity ? JSON.parse(JSON.stringify(attempt.baseValidity)) as BaseValidityPlan : undefined }
    if (mutation === 'missing') changed.baseValidity = undefined
    if (mutation === 'undercharged') changed.baseValidity!.maximumCost = (BigInt(changed.baseValidity!.maximumCost) - 1n).toString()
    if (mutation === 'changed-predicate') changed.baseValidity!.validity[0].params.value = '0x0'
    return f.reserveOriginal.call(f.ledger, changed)
  })
  const response = await f.send(await f.execution())
  expect(response.error).toBeDefined()
  expect(f.ledger.attempt(response.key)).toBeUndefined()
  expect(f.journal.get(response.key)).toBeUndefined()
  expect(f.journal.db.prepare('SELECT COUNT(*) AS total FROM credit_base_validity').get()?.total).toBe(0)
  expect(f.ledger.balance(f.owner.address)).toMatchObject({ reserved: 0n, available: f.deposit })
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
})

it.each(['absent', 'changed'])('rejects an %s installed execution delegation before signing', async kind => {
  const f = await fixture(), payload = await f.execution()
  f.delegations.set(payload.request.to, kind === 'absent' ? '0x' : `0xef0100${Wallet.createRandom().address.slice(2)}`)
  expect((await f.send(payload)).error).toBeDefined()
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
})

it.each(['missing-receipt', 'orphan-block', 'missing-l1-fee', 'missing-operator-fee', 'external-loss'])(
  'blocks further signatures after %s without releasing the included Base hold', async failure => {
    const f = await fixture(), first = await f.execute(), included = f.include(first.raw!)
    await f.broadcaster.reconcile()
    const held = f.ledger.balance(f.owner.address), next = await f.execution()
    if (failure === 'missing-receipt') f.receipts.delete(first.hash!)
    if (failure === 'orphan-block') f.changed.set(included.receipt.blockNumber, id('Base orphaned inclusion'))
    if (failure === 'external-loss') f.state.balance--
    if (failure === 'missing-l1-fee' || failure === 'missing-operator-fee') {
      const send = f.provider.send.getMockImplementation()!
      f.provider.send.mockImplementation(async (method, params) => {
        if (failure === 'missing-operator-fee' && method === 'eth_call') return '0x'
        const result = await send(method, params)
        if (failure === 'missing-l1-fee' && method === 'eth_getTransactionReceipt') return { ...(result as Record<string, unknown>), l1Fee: undefined }
        return result
      })
    }
    expect(await f.broadcaster.available()).toBe(false)
    expect((await f.send(next)).error).toBeDefined()
    await f.broadcaster.reconcile()
    expect(f.ledger.balance(f.owner.address)).toEqual(held)
    expect(f.ledger.earned()).toBe(0n)
    expect(f.sign).toHaveBeenCalledTimes(1)
    expect(f.sender.broadcastTransaction).toHaveBeenCalledTimes(1)
  },
)

it.each(['missing', 'corrupt'])('refuses signed-journal restart with a %s Base plan', async failure => {
  const f = await fixture(), first = await f.execute(), held = f.ledger.balance(f.owner.address)
  expect(() => f.journal.db.prepare('DELETE FROM credit_base_validity WHERE key=?').run(first.key)).toThrow('immutable')
  // Simulate damaged imported storage after demonstrating the normal mutation is rejected.
  if (failure === 'missing') {
    f.journal.db.exec('DROP TRIGGER immutable_credit_base_validity_delete')
    f.journal.db.prepare('DELETE FROM credit_base_validity WHERE key=?').run(first.key)
  } else {
    const plan = JSON.parse(JSON.stringify(f.ledger.baseValidity(first.key))) as BaseValidityPlan
    plan.maximumCost = (BigInt(plan.maximumCost) - 1n).toString()
    f.journal.db.exec('DROP TRIGGER immutable_credit_base_validity_update')
    f.journal.db.prepare('UPDATE credit_base_validity SET plan=? WHERE key=?').run(JSON.stringify(plan), first.key)
  }
  await expect(f.restart()).rejects.toThrow('Base')
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.sign).toHaveBeenCalledTimes(1)
  expect(f.sender.broadcastTransaction).toHaveBeenCalledTimes(1)
})

it('recovers an unsigned crash reservation with the exact original predicates', async () => {
  const f = await fixture()
  f.sign.mockRejectedValueOnce(new Error('Synthetic crash after atomic reservation'))
  const response = await f.send(await f.execution()), first = f.journal.get(response.key)!
  expect(response.error).toBeDefined()
  expect(first.raw).toBeNull()
  const originalPlan = f.ledger.baseValidity(first.key)!, held = f.ledger.balance(f.owner.address)
  f.words.set(`${f.l1}:0x1`, 2_000_000_000n)
  await f.restart()
  const hash = await f.retry(), recovered = f.journal.get(first.key)!
  expect(hash).toBe(recovered.hash)
  expect(f.sender.stageSigned).toHaveBeenCalledWith(recovered.raw, originalPlan)
  expect(f.ledger.baseValidity(first.key)).toEqual(originalPlan)
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.sign).toHaveBeenCalledTimes(2)
})

it('retains original predicates while reserving a fully covered cancellation before signing', async () => {
  const f = await fixture(), first = await f.execute(), originalPlan = f.ledger.baseValidity(first.key)!
  const held = f.ledger.balance(f.owner.address)
  f.words.set(`${f.l1}:0x1`, 2_000_000_000n)
  await f.restart()
  const hash = await f.cancel(), cancelled = f.journal.get(first.key)!, tx = Transaction.from(cancelled.cancel_raw!)
  const cancellationPlan = f.ledger.baseValidity(first.key, tx.unsignedSerialized)!
  expect(hash).toBe(tx.hash)
  expect(cancellationPlan.validity[0].params.value).not.toBe(originalPlan.validity[0].params.value)
  expect(validateBaseValidityPlan(cancellationPlan, tx.unsignedSerialized)).toEqual(cancellationPlan)
  expect(BigInt(cancellationPlan.maximumCost)).toBeGreaterThan(tx.gasLimit * tx.maxFeePerGas!)
  expect(BigInt(cancelled.max_cost)).toBe(BigInt(originalPlan.maximumCost))
  expect(f.sender.cancelPending).toHaveBeenCalledWith(cancelled.cancel_raw, cancellationPlan)
  expect(f.ledger.baseValidity(first.key)).toEqual(originalPlan)
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  const included = f.include(cancelled.cancel_raw!)
  f.state.finalized = f.state.head
  await f.broadcaster.reconcile()
  expect(f.ledger.balance(f.owner.address)).toMatchObject({ reserved: 0n, refunds: 0n,
    charged: f.creditCharge(included.cost, BigInt(f.quote.rate), 0n) })
})

it('resumes a cancellation signing crash with its exact reserved plan without renewing predicates', async () => {
  const f = await fixture(), first = await f.execute(), held = f.ledger.balance(f.owner.address)
  f.sign.mockRejectedValueOnce(new Error('Synthetic cancellation signing crash'))
  await expect(f.cancel()).rejects.toThrow('Synthetic cancellation signing crash')
  const row = f.journal.db.prepare('SELECT plan FROM credit_base_validity WHERE key=? AND unsigned<>?')
    .get(first.key, f.ledger.attempt(first.key)!.unsigned)!
  const saved = validateBaseValidityPlan(JSON.parse(String(row.plan)))
  expect(f.journal.get(first.key)?.cancel_raw).toBeNull()
  expect(() => f.ledger.reserveBaseCancellation(first.key, saved)).not.toThrow()
  expect(() => f.ledger.reserveBaseCancellation(first.key, { ...saved, feeExpiryMs: saved.feeExpiryMs + 1000 }))
    .toThrow('immutable')
  f.words.set(`${f.l1}:0x1`, 2_000_000_000n)
  f.provider.estimateGas.mockResolvedValue(100_000n)
  const estimates = f.provider.estimateGas.mock.calls.length
  await f.restart()
  const hash = await f.cancel(), cancelled = f.journal.get(first.key)!
  expect(hash).toBe(cancelled.cancel_hash)
  expect(f.sender.cancelPending).toHaveBeenCalledExactlyOnceWith(cancelled.cancel_raw, saved)
  expect(f.ledger.baseValidity(first.key, saved.unsigned)).toEqual(saved)
  expect(f.journal.db.prepare('SELECT COUNT(*) AS total FROM credit_base_validity').get()?.total).toBe(2)
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.sign).toHaveBeenCalledTimes(3)
  expect(f.provider.estimateGas).toHaveBeenCalledTimes(estimates)
  expect(Transaction.from(cancelled.cancel_raw!).unsignedSerialized).toBe(saved.unsigned)
})

it('normalizes cancellation reservation keys before storing and reusing their immutable plans', async () => {
  const f = await fixture(), first = await f.execute()
  const original = Transaction.from(first.raw!)
  const tx = Transaction.from({ type: 2, chainId: 8453n, nonce: original.nonce,
    to: f.wallet.address, value: 0n, data: '0x', gasLimit: 23_100n,
    maxFeePerGas: original.maxFeePerGas! * 2n, maxPriorityFeePerGas: original.maxPriorityFeePerGas! * 2n })
  const plan = await prepareBaseValidity(f.rpc, tx, Date.now() + 60_000)
  const mixedCaseKey = `0x${first.key.slice(2).toUpperCase()}`
  expect(() => f.ledger.reserveBaseCancellation(mixedCaseKey, plan)).not.toThrow()
  expect(f.ledger.baseValidity(first.key, tx.unsignedSerialized)).toEqual(plan)
  expect(f.ledger.baseCancellation(first.key, tx.maxFeePerGas!, tx.maxPriorityFeePerGas!)).toEqual(plan)
  expect(() => f.ledger.reserveBaseCancellation(first.key, plan)).not.toThrow()
  expect(() => f.ledger.reserveBaseCancellation(mixedCaseKey, plan)).not.toThrow()
  expect(f.journal.db.prepare('SELECT COUNT(*) AS total FROM credit_base_validity WHERE key=?').get(first.key)?.total).toBe(2)
})

it.each(['quote', 'block'])('does not sign or renew a cancellation crash reservation after its %s expiry', async kind => {
  const f = await fixture(), first = await f.execute(), held = f.ledger.balance(f.owner.address)
  f.sign.mockRejectedValueOnce(new Error('Synthetic cancellation signing crash'))
  await expect(f.cancel()).rejects.toThrow('Synthetic cancellation signing crash')
  const row = f.journal.db.prepare('SELECT plan FROM credit_base_validity WHERE key=? AND unsigned<>?')
    .get(first.key, f.ledger.attempt(first.key)!.unsigned)!
  const saved = validateBaseValidityPlan(JSON.parse(String(row.plan)))
  if (kind === 'quote') vi.spyOn(Date, 'now').mockReturnValue(saved.feeExpiryMs)
  else f.state.head = saved.expiryBlock
  await expect(f.cancel()).rejects.toThrow('saved Base cancellation fee predicates expired')
  expect(f.ledger.baseValidity(first.key, saved.unsigned)).toEqual(saved)
  expect(f.journal.get(first.key)?.cancel_raw).toBeNull()
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.sign).toHaveBeenCalledTimes(2)
  expect(f.sender.cancelPending).not.toHaveBeenCalled()
})

it('rejects a cancellation whose L1 fee makes its total exceed the funded cap before signing', async () => {
  const f = await fixture(), first = await f.execute(), held = f.ledger.balance(f.owner.address)
  f.words.set(`${f.l1}:0x1`, 10n ** 23n)
  await expect(f.cancel()).rejects.toThrow('total network fee')
  expect(f.journal.get(first.key)?.cancel_raw).toBeNull()
  expect(f.journal.db.prepare('SELECT COUNT(*) AS total FROM credit_base_validity').get()?.total).toBe(1)
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.sign).toHaveBeenCalledTimes(1)
  expect(f.sender.cancelPending).not.toHaveBeenCalled()
})
