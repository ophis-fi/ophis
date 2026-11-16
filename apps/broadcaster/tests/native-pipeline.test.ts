import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ed from '@noble/ed25519'
import { encryptDataWithSharedKey, tryDecryptJSONDataWithSharedKey } from '@railgun-community/wallet'
import { id, Interface, JsonRpcProvider, Transaction, Wallet, ZeroAddress, type TransactionReceipt } from 'ethers'
import type { Store } from '../src/storage'

let store: Store | undefined, directory: string
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '42161')
  directory = mkdtempSync(join(tmpdir(), 'ophis-native-pipeline-'))
})
afterEach(() => {
  store?.close(); store = undefined
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules()
})

async function fixture(mainnet = false) {
  const [{ Store }, { Broadcaster }, { CreditLedger, creditCharge }, { config, privateRequest, withdrawalRequest }, { ADAPT, PROXY },
    { CHAIN, CHAIN_ID, NETWORK, settings: readSettings }, protocol, { recover }, guardCode] = await Promise.all([
    import('../src/storage'), import('../src/broadcaster'), import('../src/credit'), import('./request.fixture'),
    import('../src/transaction'), import('../src/config'), import('../../railgun/credit-protocol'), import('../src/recovery'),
    import('../../railgun/operator/execution-guard'),
  ])
  expect(CHAIN_ID).toBe(42161)
  const journal = store = new Store(directory), wallet = new Wallet(Wallet.createRandom().privateKey), owner = Wallet.createRandom()
  journal.bindIdentity(CHAIN_ID, wallet.address)
  // Production promotion loads an already initialized ledger; normal public
  // discovery must never create another identity against an existing gas wallet.
  const initialized = mainnet ? new CreditLedger(journal,
    { chainId: CHAIN_ID, operator: wallet.address, recipient: wallet.address, token: ZeroAddress, funding: 'native' }) : undefined
  const guard = mainnet ? Wallet.createRandom().address : undefined
  const settings = mainnet ? readSettings({ OPHIS_BROADCASTER_CHAIN_ID: '42161', OPHIS_BROADCASTER_MODE: 'mainnet',
    OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_ADMISSION: 'public', OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'public-native',
    OPHIS_BROADCASTER_RPC: 'https://arb-mainnet.g.alchemy.com/v2/synthetic-public-transition',
    OPHIS_BROADCASTER_WRITE_RPC: 'https://arb-mainnet.g.alchemy.com/v2/synthetic-public-transition',
    OPHIS_BROADCASTER_OPERATOR_ADDRESS: wallet.address, OPHIS_BROADCASTER_EXECUTION_GUARD: guard,
    OPHIS_BROADCASTER_CREDIT_LEDGER_ID: initialized?.id,
    OPHIS_BROADCASTER_MARGIN_BPS: '1500', OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: config.maxGasPrice.toString(),
    OPHIS_BROADCASTER_MAX_TX_COST_WEI: config.maxTransactionCost.toString(),
    OPHIS_BROADCASTER_DAILY_BUDGET_WEI: config.dailyBudget.toString(), OPHIS_BROADCASTER_RESERVE_WEI: config.reserve.toString(),
  }) : { ...config, admission: 'public' as const, creditPaymentMode: 'public-native' as const }
  const deposit = 10n ** 18n, state = { head: 100, finalized: 99, nonce: 0, balance: deposit + settings.reserve }
  const changed = new Map<number, string>(), receipts = new Map<string, TransactionReceipt>()
  const transactions = new Map<string, Record<string, unknown>>()
  const block = (number: number) => ({ number, hash: changed.get(number) ?? id(`pipeline block ${number}`),
    timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n })
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
      ? guardCode.executionGuardCode(wallet.address, '0x6001', NETWORK.relayAdapt7702Contract) : '0x6001'),
    getFeeData: vi.fn(async () => ({ gasPrice: 2n, maxPriorityFeePerGas: 1n })),
    estimateGas: vi.fn(async () => 100_000n), getRpcTransaction: vi.fn(value => value),
    call: vi.fn(async (tx: { data: string }) => {
      if (tx.data.startsWith(registry.getFunction('getContractAddress')!.selector))
        return registry.encodeFunctionResult('getContractAddress', [NETWORK.relayAdapt7702Contract])
      if (tx.data === ADAPT.encodeFunctionData('adaptImplementation'))
        return ADAPT.encodeFunctionResult('adaptImplementation', [NETWORK.relayAdapt7702Contract])
      return ADAPT.encodeFunctionResult('nonce', [0n])
    }),
    send: vi.fn(async (method: string, params: any[]): Promise<unknown> => {
      if (method === 'eth_estimateGas') return '0x186a0'
      const [tx] = params
      const data = tx.to === guard ? guardCode.decodeGuardedExecution(tx.data).execution : tx.data
      return tx.data === '0x'
        ? { type: 'CALL', from: tx.from, to: tx.to, input: '0x', value: `0x${tx.value.toString(16)}` }
        : { type: 'CALL', calls: [{ type: 'CALL', to: NETWORK.proxyContract,
          input: data.startsWith(PROXY.getFunction('transact')!.selector) ? data
            : PROXY.encodeFunctionData('transact', [ADAPT.decodeFunctionData('execute', data)._transactions]) }] }
    }),
  }
  const privateViewingKey = randomBytes(32), publicViewingKey = Buffer.from(await ed.getPublicKey(privateViewingKey)).toString('hex')
  const sdk = { address: '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f',
    privateViewingKey, publicViewingKey, ready: () => true, sign: vi.fn(async () => 'signature'), fee: vi.fn(async () => ({})),
    validate: vi.fn(async () => ({ railgunTxid: 'test-txid', utxoTreeIn: 0, commitment: 'test-commitment', notePublicKey: 'test-npk', pois: {} })),
    validatePrepaid: vi.fn(async () => {}), assure: vi.fn(async () => true) }
  let pointer: { hash: string; nonce: number } | undefined
  const stage = (raw: string) => { const tx = Transaction.from(raw); pointer = { hash: tx.hash!, nonce: tx.nonce }; return tx.hash! }
  const sender = { broadcastTransaction: vi.fn(async (raw: string) => ({ hash: stage(raw) })),
    pendingTransaction: vi.fn(() => pointer), stageSigned: vi.fn(async (raw: string) => stage(raw)),
    stageRecovery: vi.fn(async (raw: string, _previous: { hash: string; nonce: number }) => stage(raw)),
    retryPending: vi.fn(async () => pointer!.hash), cancelPending: vi.fn(async (raw: string) => Transaction.from(raw).hash!) }
  const sign = vi.spyOn(wallet, 'signTransaction'), rpc = provider as unknown as JsonRpcProvider
  const create = (selected = journal) => new Broadcaster(settings, selected, sdk, rpc, wallet, sender, { rates: async () => ({}) })
  let broadcaster = create()
  const info = await broadcaster.creditInfo(), ledger = CreditLedger.load(journal)
  async function send(payload: Record<string, unknown>, authorizer: Pick<Wallet, 'signTypedData'> = owner) {
    const encoded = JSON.stringify(payload), expires = Date.now() + 240_000
    const signature = await authorizer.signTypedData(protocol.creditDomain(info.scope, info.ledgerId), protocol.CREDIT_AUTHORIZATION_TYPES,
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
  const execution = async () => ({ kind: 'execute', sequence: ledger.nextSequence(owner.address),
    request: await privateRequest(quote.feesID, publicViewingKey, id(`pipeline nullifier ${ledger.nextSequence(owner.address)}`)),
    maximumCharge: quote.maximumCharge, collectionAllowance: quote.collectionAllowance })
  const withdrawal = async (recipient = owner.address) => ({ ...await execution(),
    request: await withdrawalRequest(quote.feesID, publicViewingKey, recipient) })
  const execute = async () => {
    const response = await send(await execution())
    expect(response.error).toBeUndefined()
    return journal.get(response.key)!
  }
  const include = (raw: string, status = 1) => {
    const tx = Transaction.from(raw), included = block(++state.head), gasUsed = 50_000n, gasPrice = tx.maxFeePerGas ?? tx.gasPrice!
    const cost = gasUsed * gasPrice
    const receipt = { hash: tx.hash!, from: tx.from!, to: tx.to, blockNumber: included.number,
      blockHash: included.hash, status, gasUsed, gasPrice } as TransactionReceipt
    receipts.set(tx.hash!, receipt); state.nonce = tx.nonce + 1; state.balance -= cost + (status === 1 ? tx.value : 0n)
    return { receipt, cost }
  }
  return { journal, ledger, owner, wallet, deposit, settings, state, provider, rpc, receipts, changed, quote, sender, sign, sdk,
    get broadcaster() { return broadcaster }, create, send, execution, withdrawal, execute, include, creditCharge,
    restart: async () => { broadcaster = create(); await broadcaster.creditInfo() },
    retry: () => recover('retry', [], settings, journal, rpc, wallet, sender) }
}

it('estimates the COMMON withdrawal at the priced head without ethers redundant fee reads', async () => {
  const f = await fixture(), rpc = new JsonRpcProvider('http://127.0.0.1:1', 42161,
    { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 })
  const calls: Array<{ method: string; params: unknown }> = []
  vi.spyOn(rpc, '_send').mockImplementation(async payload => {
    if (Array.isArray(payload)) throw new Error('Unexpected batch')
    calls.push({ method: payload.method, params: payload.params })
    if (payload.method === 'eth_getBlockByNumber')
      return [{ id: payload.id, result: undefined, error: { code: -32000, message: 'PRIVATE extra latest read failed' } }]
    if (payload.method === 'eth_gasPrice' || payload.method === 'eth_maxPriorityFeePerGas')
      return [{ id: payload.id, result: '0x2' }]
    if (payload.method !== 'eth_estimateGas') throw new Error('Unexpected RPC method')
    expect(payload.params).toEqual([expect.objectContaining({ type: '0x1' }), '0x64'])
    return [{ id: payload.id, result: '0x79006' }]
  })
  try {
    // This is the old library path: its extra read fails before dispatching the estimate.
    await expect(rpc.estimateGas({ type: 1, from: f.wallet.address, to: f.wallet.address,
      gasPrice: 2n, blockTag: 100 })).rejects.toThrow()
    expect(calls.some(call => call.method === 'eth_estimateGas')).toBe(false)
    calls.length = 0
    const send = f.provider.send.getMockImplementation()!
    f.provider.send.mockImplementation((method, params) => method === 'eth_estimateGas' ? rpc.send(method, params) : send(method, params))
    f.provider.getRpcTransaction.mockImplementation(tx => rpc.getRpcTransaction(tx))
    const request = await f.withdrawal(), result = await f.send(request)
    expect(result.error).toBeUndefined()
    expect(calls).toEqual([{ method: 'eth_estimateGas', params: [expect.objectContaining({
      type: '0x1', from: f.wallet.address.toLowerCase(), to: request.request.to.toLowerCase(),
      data: request.request.data, gasPrice: '0x77359400', nonce: '0x0', value: '0x0', chainId: '0xa4b1',
    }), '0x64'] }])
    const wire = (calls[0].params as Record<string, unknown>[])[0]
    for (const field of ['gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'authorizationList']) expect(wire).not.toHaveProperty(field)
    expect(f.provider.estimateGas).not.toHaveBeenCalled()
    const signed = Transaction.from(f.journal.get(result.key)!.raw!)
    expect(signed.type).toBe(1)
    expect(signed.gasLimit).toBe(545185n)
    expect(f.ledger.balance(f.owner.address).reserved).toBeGreaterThan(0n)
    expect(f.sign).toHaveBeenCalledTimes(1)
  } finally { rpc.destroy() }
})

it.each([null, 495622, '495622', '0x0', '0x00', '0x01', '-0x1', '0x', `0x1${'0'.repeat(64)}`])(
  'rejects malformed COMMON estimate %# before reserving credit or signing', async estimate => {
    const f = await fixture(), balance = f.ledger.balance(f.owner.address)
    f.provider.send.mockResolvedValue(estimate)
    const result = await f.send(await f.withdrawal())
    expect(result.error).toContain('[estimate:other]')
    expect(f.ledger.balance(f.owner.address)).toEqual(balance)
    expect(f.sign).not.toHaveBeenCalled()
    expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
    expect(f.journal.hasPending()).toBe(false)
  })

it.each(['fee', 'nonce', 'gas-allowance', 'prepaid-limit', 'revert', 'provider-error'])('keeps the COMMON %s gate after pinned estimation', async failure => {
  const f = await fixture(), balance = f.ledger.balance(f.owner.address), send = f.provider.send.getMockImplementation()!
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  if (failure === 'fee') f.sdk.validatePrepaid.mockImplementation(async () => {
    const getBlock = f.provider.getBlock.getMockImplementation()!
    f.provider.getBlock.mockImplementation(async tag => ({ ...await getBlock(tag), baseFeePerGas: 3_000_000_000n }))
  })
  if (failure === 'nonce') f.sdk.validatePrepaid.mockImplementation(async () => { f.state.nonce++ })
  if (failure === 'prepaid-limit') f.settings.maxTransactionCost = 1n
  if (failure === 'gas-allowance') f.provider.send.mockImplementation(async (method, params) =>
    method === 'eth_estimateGas' ? '0x7a1200' : send(method, params))
  if (failure === 'revert' || failure === 'provider-error') f.provider.send.mockRejectedValue({ code: -32000,
    message: `${failure === 'revert' ? 'execution reverted' : 'max fee per gas less than block base fee'}: PRIVATE payload` })
  const result = await f.send(await f.withdrawal())
  expect(result.error).toBeDefined()
  if (failure === 'fee' || failure === 'nonce') expect(result.error).toContain('Execution conditions changed')
  if (failure === 'gas-allowance') expect(result.error).toContain('Estimated gas exceeds')
  if (failure === 'prepaid-limit') expect(result.error).toContain('operator gas budget')
  if (failure === 'provider-error') expect(result.error).toContain('[estimate:gas-price-below-base:-32000]')
  if (failure === 'revert') expect(result.error).toContain('[estimate:execution:-32000]')
  expect(JSON.stringify(log.mock.calls) + JSON.stringify(result)).not.toContain('PRIVATE')
  expect(f.ledger.balance(f.owner.address)).toEqual(balance)
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
  expect(f.journal.hasPending()).toBe(false)
})

it.each(['execute', 'refund'])('admits a second included request while retaining the entire %s hold until finality', async kind => {
  const f = await fixture()
  let first = kind === 'execute' ? await f.execute() : undefined
  if (!first) {
    const quote = await f.send({ kind: 'quote', refund: true }), net = 10n ** 15n
    const response = await f.send({ kind: 'refund', sequence: quote.nextSequence, recipient: Wallet.createRandom().address,
      gross: (net + BigInt(quote.maximumCharge)).toString(), net: net.toString(), feesID: quote.feesID,
      collectionAllowance: '0', refundGasAllowance: quote.refundGasAllowance })
    expect(response.error).toBeUndefined(); first = f.journal.get(response.key)!
  }
  const firstIncluded = f.include(first.raw!), firstMaximum = BigInt(f.ledger.attempt(first.key)!.maximum_charge)
  await f.broadcaster.reconcile()
  expect(f.ledger.balance(f.owner.address)).toMatchObject({ available: f.deposit - firstMaximum, charged: 0n, reserved: firstMaximum, refunds: 0n })
  expect(f.ledger.earned()).toBe(0n)
  expect(await f.broadcaster.available()).toBe(true)
  const second = await f.execute(), secondIncluded = f.include(second.raw!, 0)
  await f.broadcaster.reconcile()
  const maximum = firstMaximum + BigInt(f.ledger.attempt(second.key)!.maximum_charge)
  expect(f.ledger.balance(f.owner.address)).toMatchObject({ available: f.deposit - maximum, charged: 0n, reserved: maximum })
  expect(f.journal.exposure()).toBe(BigInt(first.max_cost) + BigInt(second.max_cost))
  expect(f.ledger.earned()).toBe(0n)
  await f.restart()
  expect(await f.broadcaster.available()).toBe(true)
  f.state.finalized = f.state.head
  await f.broadcaster.reconcile()
  const fees = f.creditCharge(firstIncluded.cost, BigInt(f.quote.rate), 0n) + f.creditCharge(secondIncluded.cost, BigInt(f.quote.rate), 0n)
  const paid = kind === 'refund' ? Transaction.from(first.raw!).value : 0n
  expect(f.ledger.balance(f.owner.address)).toMatchObject({ reserved: 0n, charged: fees, refunds: paid, available: f.deposit - fees - paid })
  expect(f.ledger.earned()).toBe(fees - firstIncluded.cost - secondIncluded.cost)
  expect(f.sign).toHaveBeenCalledTimes(2)
})

it.each(['unknown-consumption', 'missing-receipt', 'orphan-block', 'external-loss'])('blocks %s without spending or releasing the preceding reservation', async failure => {
  const f = await fixture(), first = await f.execute(), included = f.include(first.raw!)
  await f.broadcaster.reconcile()
  const next = await f.execution(), held = f.ledger.balance(f.owner.address)
  if (failure === 'unknown-consumption') f.state.nonce++
  if (failure === 'missing-receipt') f.receipts.delete(first.hash!)
  if (failure === 'orphan-block') f.changed.set(included.receipt.blockNumber, id('replacement block'))
  if (failure === 'external-loss') f.state.balance--
  expect(await f.broadcaster.available()).toBe(false)
  expect((await f.send(next)).error).toBeDefined()
  await f.broadcaster.reconcile()
  if (failure === 'missing-receipt' || failure === 'orphan-block') expect(f.journal.get(first.key)?.confirmed).toBe(0)
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.sign).toHaveBeenCalledTimes(1)
  expect(f.sender.broadcastTransaction).toHaveBeenCalledTimes(1)
})

it('keeps the 20-attempt capacity across restart and admits again only after a finalized settlement', async () => {
  const f = await fixture(), operations = []
  for (let nonce = 0; nonce < 20; nonce++) {
    if (nonce === 10) await f.restart()
    const operation = await f.execute(); operations.push(operation)
    f.include(operation.raw!); await f.broadcaster.reconcile()
  }
  const held = f.ledger.balance(f.owner.address)
  await f.restart()
  expect((await f.broadcaster.creditInfo()).executionEnabled).toBe(false)
  expect(await f.broadcaster.available()).toBe(false)
  expect((await f.send(await f.execution())).error).toBeDefined()
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.sign).toHaveBeenCalledTimes(20)
  f.state.finalized = f.receipts.get(operations[0].hash!)!.blockNumber
  await f.broadcaster.reconcile()
  expect(await f.broadcaster.available()).toBe(true)
  expect((await f.execute()).nonce).toBe(20)
  expect(f.ledger.balance(f.owner.address).reserved).toBe(held.reserved)
  expect(f.sign).toHaveBeenCalledTimes(21)
}, 20_000)

it('recovers the first orphaned nonce above finality while preserving the included prefix and newer holds', async () => {
  const f = await fixture(), first = await f.execute()
  f.include(first.raw!); await f.broadcaster.reconcile()
  const second = await f.execute(), orphaned = f.include(second.raw!)
  await f.broadcaster.reconcile()
  const third = await f.execute(), held = f.ledger.balance(f.owner.address)
  f.receipts.delete(second.hash!); f.state.nonce = 1; f.state.balance += orphaned.cost
  await f.broadcaster.reconcile()
  expect(f.journal.get(first.key)?.confirmed).toBe(1)
  expect(f.journal.get(second.key)?.confirmed).toBe(0)
  expect(await f.retry()).toBe(second.hash)
  expect(f.sender.stageRecovery).toHaveBeenCalledWith(second.raw, { hash: third.hash, nonce: 2 })
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.sign).toHaveBeenCalledTimes(3)
  for (const operation of [first, second, third]) expect(f.journal.get(operation.key)?.raw).toBe(operation.raw)
})

it('stages a signed crash-gap request when the transport still points to its included predecessor', async () => {
  const f = await fixture(), first = await f.execute()
  f.include(first.raw!); await f.broadcaster.reconcile()
  f.sender.broadcastTransaction.mockRejectedValueOnce(new Error('Synthetic crash before transport staging'))
  const response = await f.send(await f.execution()), second = f.journal.get(response.key)!
  expect(response.error).toBeDefined()
  expect(second.raw).not.toBeNull()
  expect(f.sender.pendingTransaction()).toEqual({ hash: first.hash, nonce: 0 })
  const held = f.ledger.balance(f.owner.address)
  expect(await f.retry()).toBe(second.hash)
  expect(f.sender.stageSigned).toHaveBeenCalledWith(second.raw)
  expect(f.sender.stageRecovery).not.toHaveBeenCalled()
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.sign).toHaveBeenCalledTimes(2)
})

it('recovers an orphaned signature while retaining a later unsigned reservation without signing it', async () => {
  const f = await fixture(), first = await f.execute(), orphaned = f.include(first.raw!)
  await f.broadcaster.reconcile()
  f.sign.mockRejectedValueOnce(new Error('Synthetic crash after reservation'))
  const response = await f.send(await f.execution()), second = f.journal.get(response.key)!
  expect(response.error).toBeDefined()
  expect(second).toMatchObject({ nonce: 1, raw: null, hash: null, confirmed: 0 })
  const held = f.ledger.balance(f.owner.address), unsigned = f.ledger.attempt(second.key)!.unsigned
  f.receipts.delete(first.hash!); f.state.nonce = 0; f.state.balance += orphaned.cost
  await f.broadcaster.reconcile()
  expect(f.journal.get(first.key)?.confirmed).toBe(0)
  f.sign.mockClear()
  expect(await f.retry()).toBe(first.hash)
  expect(f.sender.retryPending).toHaveBeenCalledOnce()
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.journal.get(second.key)).toMatchObject({ raw: null, hash: null, confirmed: 0 })
  expect(f.ledger.attempt(second.key)!.unsigned).toBe(unsigned)
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
})

it('promotes the used Arbitrum pilot ledger without losing credit, changing its identity or requiring account allowlist updates', async () => {
  const f = await fixture(true)
  Object.assign(f.settings, { admission: 'pilot', prepaidPilotLedgerId: f.ledger.id,
    prepaidPilotOwner: f.owner.address, pilotWithdrawalRecipient: f.owner.address,
    pilotAccount: Wallet.createRandom().address })
  await f.restart()
  const firstResponse = await f.send(await f.withdrawal())
  expect(firstResponse.error).toBeUndefined()
  const first = f.journal.get(firstResponse.key)!, pilotKey = `prepaidWithdrawalPilot:${f.ledger.id}`
  let totalGas = f.include(first.raw!).cost
  f.state.finalized = f.state.head
  await f.broadcaster.reconcile()
  expect(await f.broadcaster.available()).toBe(false)
  expect((await f.broadcaster.creditInfo()).executionEnabled).toBe(false)
  expect(f.journal.db.prepare('SELECT value FROM settings WHERE key=?').get(pilotKey)?.value).toBe(first.key)
  const identity = f.journal.db.prepare('SELECT * FROM credit_identity').get()
  const funding = f.ledger.nativeDeposits(), before = f.ledger.balance(f.owner.address), settledPilot = f.journal.get(first.key)

  f.settings.admission = 'public'
  delete f.settings.prepaidPilotLedgerId; delete f.settings.prepaidPilotOwner
  delete f.settings.pilotAccount; delete f.settings.pilotWithdrawalRecipient
  await f.restart()
  expect((await f.broadcaster.creditInfo()).executionEnabled).toBe(true)
  expect(await f.broadcaster.available()).toBe(true)
  expect(f.journal.db.prepare('SELECT * FROM credit_identity').get()).toEqual(identity)
  expect(f.ledger.balance(f.owner.address)).toEqual(before)
  expect(f.ledger.nativeDeposits()).toEqual(funding)
  expect(f.journal.get(first.key)).toEqual(settledPilot)

  const secondPayload = await f.execution(), swapAccounts = new Set([secondPayload.request.to])
  const foreign = await f.send(secondPayload, Wallet.createRandom())
  expect(foreign.error).toBeDefined()
  expect(f.ledger.balance(f.owner.address)).toEqual(before)
  expect(f.ledger.nextSequence(f.owner.address)).toBe(2)
  expect(f.sign).toHaveBeenCalledTimes(1)
  expect(f.journal.db.prepare('SELECT COUNT(*) AS count FROM credit_attempts').get()?.count).toBe(1)

  for (const status of [1, 0]) {
    const payload = status === 1 ? secondPayload : await f.execution()
    swapAccounts.add(payload.request.to)
    const response = await f.send(payload)
    expect(response.error).toBeUndefined()
    const operation = f.journal.get(response.key)!
    totalGas += f.include(operation.raw!, status).cost
    f.state.finalized = f.state.head
    await f.broadcaster.reconcile()
    await f.restart()
    expect(await f.broadcaster.available()).toBe(true)
  }
  expect(swapAccounts.size).toBe(2)
  const secondWithdrawal = await f.send(await f.withdrawal(Wallet.createRandom().address))
  expect(secondWithdrawal.error).toBeUndefined()
  totalGas += f.include(f.journal.get(secondWithdrawal.key)!.raw!).cost
  f.state.finalized = f.state.head
  await f.broadcaster.reconcile()
  expect(f.ledger.balance(f.owner.address)).toMatchObject({ deposited: f.deposit, reserved: 0n,
    charged: f.creditCharge(totalGas, BigInt(f.quote.rate), 0n),
    available: f.deposit - f.creditCharge(totalGas, BigInt(f.quote.rate), 0n) })
  expect(f.ledger.nextSequence(f.owner.address)).toBe(5)
  expect(f.journal.db.prepare('SELECT COUNT(*) AS count FROM credit_attempts').get()?.count).toBe(4)
  expect(f.journal.db.prepare('SELECT * FROM credit_identity').get()).toEqual(identity)
  expect(f.ledger.nativeDeposits()).toEqual(funding)
  expect(f.journal.get(first.key)).toEqual(settledPilot)
  expect(f.journal.db.prepare('SELECT value FROM settings WHERE key=?').get(pilotKey)?.value).toBe(first.key)
  expect(f.sign).toHaveBeenCalledTimes(4)
  expect(f.sender.broadcastTransaction).toHaveBeenCalledTimes(4)
}, 20_000)

it.each(['database', 'file'])('keeps the public Arbitrum ledger locked for restore review with its %s marker', async marker => {
  const f = await fixture(true), operation = await f.execute()
  f.include(operation.raw!); f.state.finalized = f.state.head
  await f.broadcaster.reconcile()
  const identity = f.journal.db.prepare('SELECT * FROM credit_identity').get()
  const held = f.ledger.balance(f.owner.address), funding = f.ledger.nativeDeposits(), saved = f.journal.get(operation.key)
  if (marker === 'database') f.journal.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('creditRecoveryRequired', '1')
  else writeFileSync(join(directory, '.prepaid-restore-review-required'), 'synthetic-restore-review', { mode: 0o600 })
  await f.restart()
  expect((await f.broadcaster.creditInfo()).executionEnabled).toBe(false)
  expect(await f.broadcaster.available()).toBe(false)
  expect((await f.send(await f.execution())).error).toBeDefined()
  expect(() => f.ledger.assertOwnerJournalReady()).toThrow(/recovery review/)
  expect(f.ledger.balance(f.owner.address)).toEqual(held)
  expect(f.ledger.nativeDeposits()).toEqual(funding)
  expect(f.journal.db.prepare('SELECT * FROM credit_identity').get()).toEqual(identity)
  expect(f.journal.get(operation.key)).toEqual(saved)
  expect(f.sign).toHaveBeenCalledTimes(1)
  expect(f.sender.broadcastTransaction).toHaveBeenCalledTimes(1)
})

it.each(['missing', 'different'])('rejects a %s ledger after a funded public operator has already settled an attempt', async kind => {
  const f = await fixture(true), operation = await f.execute()
  f.include(operation.raw!); f.state.finalized = f.state.head
  await f.broadcaster.reconcile()
  const { Store } = await import('../src/storage'), { CreditLedger } = await import('../src/credit')
  const other = new Store(join(directory, 'wrong-state')), balance = f.ledger.balance(f.owner.address)
  try {
    other.bindIdentity(42161, f.wallet.address)
    if (kind === 'different') {
      const wrong = new CreditLedger(other, f.ledger.scope, f.state.nonce)
      expect(wrong.id).not.toBe(f.ledger.id)
    }
    const nonceReads = f.provider.getTransactionCount.mock.calls.length
    await expect(f.create(other).creditInfo()).rejects.toThrow('configured identity')
    expect(f.provider.getTransactionCount).toHaveBeenCalledTimes(nonceReads)
    expect(await f.create(other).available()).toBe(false)
    expect(f.sign).toHaveBeenCalledTimes(1)
    expect(f.sender.broadcastTransaction).toHaveBeenCalledTimes(1)
    expect(f.ledger.balance(f.owner.address)).toEqual(balance)
    if (kind === 'missing') expect(other.db.prepare("SELECT 1 FROM sqlite_master WHERE name='credit_identity'").get()).toBeUndefined()
    expect(other.db.prepare('SELECT COUNT(*) AS n FROM requests').get()?.n).toBe(0)
  } finally { other.close() }
})

it('refuses live missing-ledger initialization even without a pin and permits only the disabled initialization path', async () => {
  const f = await fixture(true), operation = await f.execute()
  f.include(operation.raw!); f.state.finalized = f.state.head
  await f.broadcaster.reconcile()
  const { Store } = await import('../src/storage'), { CreditLedger } = await import('../src/credit')
  const other = new Store(join(directory, 'uninitialized-state'))
  try {
    delete f.settings.creditLedgerId
    await expect(f.create(other).creditInfo()).rejects.toThrow('cannot initialize a missing prepaid ledger')
    expect(other.db.prepare("SELECT 1 FROM sqlite_master WHERE name='credit_identity'").get()).toBeUndefined()
    f.settings.enabled = false
    const disabled = f.create(other), first = await disabled.creditInfo()
    expect(first.executionEnabled).toBe(false)
    expect(first.ledgerId).not.toBe(f.ledger.id)
    expect(CreditLedger.load(other).id).toBe(first.ledgerId)
    expect((await f.create(other).creditInfo()).ledgerId).toBe(first.ledgerId)
    expect(await disabled.available()).toBe(false)
    expect(f.sign).toHaveBeenCalledTimes(1)
    expect(f.sender.broadcastTransaction).toHaveBeenCalledTimes(1)
  } finally { other.close() }
})

it('checks a configured ledger pin even after the service cached its credit instance', async () => {
  const f = await fixture(true), balance = f.ledger.balance(f.owner.address)
  f.settings.creditLedgerId = id('wrong pinned ledger')
  await expect(f.broadcaster.creditInfo()).rejects.toThrow('configured identity')
  expect((await f.send(await f.execution())).error).toBeDefined()
  expect(f.ledger.balance(f.owner.address)).toEqual(balance)
  expect(f.sign).not.toHaveBeenCalled()
  expect(f.sender.broadcastTransaction).not.toHaveBeenCalled()
})
