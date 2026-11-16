import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AbiCoder, getAddress, hexlify, id, Interface, JsonRpcProvider, keccak256, toUtf8Bytes, Wallet, ZeroAddress, ZeroHash, zeroPadValue, type JsonRpcSigner } from 'ethers'
import { ABIRailgunSmartWallet } from '@railgun-community/engine'
import { CREDIT_MAX_MESSAGE_BYTES, CREDIT_MAX_PAYLOAD, CREDIT_PROTOCOL, authenticateCreditRequest, creditMemo, creditRefundMemo, creditRequestKey } from '../credit-protocol'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({
  chainId: 1, diagnose: vi.fn(), inputSpent: vi.fn(), ensureSync: vi.fn(),
  writeError: false, record: undefined as unknown, recordKey: undefined as string | undefined, records: new Map<string, unknown>(), events: [] as string[], messages: [] as Record<string, unknown>[],
  privateSwap: undefined as unknown, privateWithdrawal: undefined as unknown,
  callback: undefined as ((value: unknown) => void) | undefined, core: {}, subscribe: vi.fn(),
  subscriptions: new Map<object, { topic: string; callback: (value: unknown) => void }>(), restart: undefined as (() => void) | undefined,
  send: vi.fn(), encrypt: vi.fn(), signPublic: vi.fn(), finalized: 100, canonical: true, available: '2000000000000000',
  nextSequence: 1, executionEnabled: true, completedHash: undefined as string | undefined, publicLatest: 0, publicPending: 0, receiptStatus: 1,
  policy: { operator: '0x001486E70A0c9291f5F55c68914eE0e4E4A604d4', railgunAddress: '',
    expiresAt: Number.MAX_SAFE_INTEGER, maxGasPrice: 500_000_000n, maxTransactionCost: 1_500_000_000_000_000n, funding: undefined as 'native' | undefined },
}))
vi.mock('./config', async (original) => {
  const config = await original<typeof import('./config')>()
  state.policy.railgunAddress = config.OPHIS_BROADCASTER
  return { ...config, get CHAIN_ID() { return state.chainId }, get CHAIN() { return BigInt(state.chainId) },
    PREPAID_BROADCASTERS: { 1: state.policy, 42161: state.policy } }
})
vi.mock('./broadcaster', () => ({ startBroadcasters: vi.fn(),
  assertSubmittable: async (session: WalletSession, selected: unknown, gas: unknown, credit: unknown) =>
    (await import('./prepaid')).assertPrepaidContext(session, selected as never, gas as never, credit as never) }))
vi.mock('./prepaid-diagnostic', async original => ({ ...await original<typeof import('./prepaid-diagnostic')>(), diagnoseSavedTransaction: state.diagnose }))
vi.mock('./storage', () => ({ readPrivateState: async (_session: unknown, key: string) => structuredClone(state.recordKey === undefined || state.recordKey === key ? state.record : state.records.get(key)),
  writePrivateState: async (_session: unknown, _key: string, value: unknown) => {
    if (state.writeError) throw new Error('Local storage quota exceeded')
    state.events.push('saved'); state.recordKey = _key; state.record = structuredClone(value); state.records.set(_key, structuredClone(value))
  } }))
vi.mock('./wallet', () => ({ ensureWalletSync: state.ensureSync, requireWalletSync: vi.fn(), refreshReceivedBalances: vi.fn() }))
vi.mock('./shield', () => ({ assertPublicNetwork: vi.fn() }))
vi.mock('./journal', () => ({ pendingSwap: async () => state.privateSwap }))
vi.mock('./withdrawal-journal', () => ({ pendingWithdrawal: async () => structuredClone(state.privateWithdrawal),
  withdrawalInputsSpent: (...args: unknown[]) => state.inputSpent(...args),
  savePendingWithdrawal: async (_session: unknown, withdrawal: unknown) => {
    state.events.push('withdrawal-saved'); state.privateWithdrawal = structuredClone(withdrawal)
  } }))
vi.mock('@railgun-community/waku-broadcaster-client-web', () => ({ WakuBroadcasterClient: {
  getWakuCore: () => state.core,
  getContentTopics: () => state.subscriptions.has(state.core) ? [state.subscriptions.get(state.core)!.topic] : [],
  setRestartCallback: (callback: () => void) => { state.restart = callback },
  addTransportSubscription: async (core: object, topic: string, callback: (value: unknown) => void) => {
    await state.subscribe(core); state.callback = callback
    state.subscriptions.set(core, { topic: `/railgun/v2/encrypted-${topic}/json`, callback })
  },
  sendTransport: (...args: unknown[]) => state.send(...args),
} }))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...await original<typeof import('@railgun-community/wallet')>(),
  getRailgunWalletAddressData: () => ({ viewingPublicKey: new Uint8Array(32).fill(1) }),
  encryptDataWithSharedKey: (...args: unknown[]) => state.encrypt(...args),
  tryDecryptJSONDataWithSharedKey: (value: [string, string], key: Uint8Array) => value[1] === hexlify(key) ? JSON.parse(value[0]) : null,
  balanceForERC20Token: async () => 10n ** 18n,
  fullWalletForID: () => ({}),
  gasEstimateForUnprovenTransfer: async () => ({ gasEstimate: 100_000n }),
  generateTransferProof: async () => { state.events.push('proved') },
  populateProvedTransfer: async () => ({ transaction: { to: proxy, data: '0xaabb', value: 0n }, nullifiers: [id('input')] }),
  getCompletedTxidFromNullifiers: async () => ({ txid: state.completedHash }),
}))
import { CONFIG, tokenFor, VERSION } from './config'
import { assertPrepaidContext, checkPrepaid, checkPrepaidRefund, claimPrepaidTopUp, diagnosePrepaidTransaction, pendingPrepaid, preparePrepaid, preparePrepaidRefund,
  deferPrepaidTopUp, prepaidAttemptFee, prepaidBalance, prepaidRefundFee, requestPrepaidRefund, retryPrepaid, submitPrepaid, topUpPrepaid,
  prepareSavedPrepaidWithdrawal, confirmSavedPrepaidWithdrawal } from './prepaid'
import { retryPrepaidTopUp } from './prepaid'

const owner = new Wallet(`0x${'11'.repeat(32)}`), publicOwner = new Wallet(`0x${'22'.repeat(32)}`)
const ledgerId = id('credit-ledger'), hash = id('transaction'), blockHash = id('block')
const proxy = getAddress(CONFIG.proxyContract)
const scope = () => ({ chainId: state.chainId, operator: state.policy.operator,
  recipient: state.policy.funding === 'native' ? state.policy.operator : state.policy.railgunAddress,
  token: state.policy.funding === 'native' ? ZeroAddress : getAddress(CONFIG.baseToken.wrappedAddress),
  ...(state.policy.funding && { funding: state.policy.funding }) })
const session = { info: { id: 'isolated-test-wallet', railgunAddress: state.policy.railgunAddress }, key: 'test-only',
  accounts: { getAccount: vi.fn(async () => ({ signer: owner })) },
  provider: {
    getCode: vi.fn(async () => '0x'),
    getNetwork: async () => ({ chainId: 1n }),
    getTransactionReceipt: vi.fn(async (requested: string) => ({ status: state.receiptStatus, blockNumber: 99, blockHash, hash: requested, gasUsed: 1000n, gasPrice: 1n })),
    getBlock: async (tag: string | number) => tag === 'finalized' ? { number: state.finalized } : { hash: state.canonical ? blockHash : id('reorg') },
    getTransaction: vi.fn(async () => ({ from: publicOwner.address, to: proxy, data: '0xaabb', value: 0n, chainId: 1n, nonce: 0 })),
  },
} as unknown as WalletSession
const gas = { evmGasType: 1 as const, gasEstimate: 100_000n, gasPrice: 100n }
const populated = { transaction: { to: proxy, data: '0xaabb', value: 0n }, nullifiers: [id('input')], preTransactionPOIsPerTxidLeafPerList: {} }
const publicSigner = { provider: { getFeeData: async () => ({ gasPrice: 10n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }),
  getCode: vi.fn(async () => '0x'),
  getTransactionCount: async (_address: string, block: string) => block === 'pending' ? state.publicPending : state.publicLatest },
  getAddress: async () => publicOwner.address, sendTransaction: (...args: unknown[]) => state.signPublic(...args),
} as unknown as JsonRpcSigner

function respond(packet: { id: string; params: { pubkey: string; encryptedData: [string, string] } },
  request: Record<string, unknown>, body: Record<string, unknown>, key?: string) {
  const response = { ...body, protocol: CREDIT_PROTOCOL, correlation: request.correlation,
    key: key ?? keccak256(toUtf8Bytes(JSON.stringify([packet.params.pubkey.toLowerCase(), packet.params.encryptedData]))) }
  state.subscriptions.get(state.core)?.callback({ payload: toUtf8Bytes(JSON.stringify({ id: packet.id, result: [JSON.stringify(response), packet.params.encryptedData[1]] })) })
}
async function server(packet: Parameters<typeof respond>[0]) {
  const request = JSON.parse(packet.params.encryptedData[0])
  state.messages.push(request)
  if (request.kind === 'info') {
    respond(packet, request, { scope: scope(), ledgerId, funding: state.policy.funding === 'native' ? 'user-submitted-native-transfer' : 'user-submitted-private-transfer', confirmation: 'finalized', executionEnabled: state.executionEnabled })
    return
  }
  const authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
  const payload = authorized.payload
  const result: Record<string, unknown> = payload.kind === 'quote'
    ? { kind: 'quote', nextSequence: state.nextSequence, feesID: 'ab'.repeat(32), expires: Date.now() + 240_000, rate: '1100000000000000000',
      collectionAllowance: state.policy.funding === 'native' ? '0' : '10000', maximumGasCost: '1500000000000000', maximumGasPrice: '500000000',
      maximumCharge: state.policy.funding === 'native' ? '1650000000000000' : '1650000000011000',
      ...(state.policy.funding === 'native' && { refundGasAllowance: '10000' }), ...(payload.refund === true && { maximumRefundGross: state.available }) }
    : payload.kind === 'execute' ? { txHash: hash, ...(state.policy.funding === 'native' && { nonce: 3 }) }
    : { kind: 'balance', owner: owner.address, ...(state.policy.funding === 'native' ? {} : { memo: creditMemo(scope(), ledgerId, owner.address) }),
      available: state.available, deposited: state.available, charged: '0', reserved: '0', refunds: '0' }
  respond(packet, request, result, authorized.key)
}
beforeEach(() => {
  vi.clearAllMocks()
  state.ensureSync.mockReset().mockResolvedValue(undefined)
  state.chainId = 1; state.diagnose.mockReset().mockResolvedValue('historical diagnostic')
  state.writeError = false; state.record = undefined; state.recordKey = undefined; state.records.clear(); state.events = []; state.messages = []; state.core = {}; state.finalized = 100; state.canonical = true
  state.subscriptions.clear(); state.subscribe.mockReset(); state.subscribe.mockResolvedValue(undefined)
  state.privateSwap = undefined; state.privateWithdrawal = undefined
  state.inputSpent.mockReset().mockResolvedValue(false)
  state.policy.expiresAt = Number.MAX_SAFE_INTEGER
  state.policy.funding = undefined
  vi.mocked(session.provider.getCode).mockResolvedValue('0x')
  vi.mocked(publicSigner.provider.getCode).mockResolvedValue('0x')
  state.available = '2000000000000000'
  state.nextSequence = 1; state.executionEnabled = true; state.completedHash = hash; state.publicLatest = 0; state.publicPending = 0; state.receiptStatus = 1
  state.send.mockImplementation(server)
  state.encrypt.mockImplementation(async (data) => ({ encryptedData: [JSON.stringify(data), `0x${'01'.repeat(32)}`],
    randomPubKey: '02'.repeat(32), sharedKey: new Uint8Array(32).fill(1) }))
  state.signPublic.mockImplementation(async () => { state.events.push('public'); return { hash } })
  vi.mocked(session.accounts.getAccount).mockResolvedValue({ signer: owner } as unknown as Awaited<ReturnType<typeof session.accounts.getAccount>>)
  vi.mocked(session.provider.getTransaction).mockResolvedValue({ from: publicOwner.address, to: proxy, data: '0xaabb', value: 0n, chainId: 1n, nonce: 0 } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  vi.mocked(session.provider.getTransactionReceipt).mockImplementation(async (requested) => ({ status: state.receiptStatus,
    blockNumber: 99, blockHash, hash: requested, gasUsed: 1000n, gasPrice: 1n } as Awaited<ReturnType<typeof session.provider.getTransactionReceipt>>))
})
afterEach(() => vi.useRealTimers())

function renewalFixture(minGasPrice = '20000000') {
  state.chainId = 42161; state.policy.funding = 'native'
  const privacy = new Interface(ABIRailgunSmartWallet), tuple = privacy.getFunction('transact')!.inputs[0].arrayChildren!
  const proof = Array.from(AbiCoder.defaultAbiCoder().getDefaultValue([tuple])[0])
  const field = (name: string) => tuple.components!.findIndex(p => p.name === name)
  const boundType = tuple.components![field('boundParams')].components!, bound = Array.from(proof[field('boundParams')] as unknown[])
  for (const [name, value] of [['unshield', 1n], ['chainID', 42161n], ['minGasPrice', 10n]] as const)
    bound[boundType.findIndex(p => p.name === name)] = value
  proof[field('boundParams')] = bound
  proof[field('nullifiers')] = [id('saved withdrawal input')]
  proof[field('commitments')] = [ZeroHash]
  proof[field('unshieldPreimage')] = [zeroPadValue(publicOwner.address, 32), [0, tokenFor('USDC').address, 0], 188659n]
  const data = privacy.encodeFunctionData('transact', [[proof]])
  const request = { txidVersion: VERSION, chainType: 0, chainID: 42161, to: proxy, data, feesID: 'cd'.repeat(32),
    useRelayAdapt: false, minVersion: '8.0.0', maxVersion: '8.999.0', transactType: 'COMMON',
    preTransactionPOIsPerTxidLeafPerList: {}, minGasPrice }
  const payload = JSON.stringify({ kind: 'execute', request, sequence: 1, maximumCharge: '50000000000000', collectionAllowance: '0' })
  const original = { payload, key: creditRequestKey(ledgerId, owner.address, payload), rate: '1100000000000000000' }
  state.record = { scope: scope(), ledgerId, owner: owner.address, attempt: original }
  const withdrawal = { chainId: 42161, feeMode: 'prepaid' as const, token: 'USDC' as const,
    feeToken: 'WETH' as const, broadcaster: state.policy.railgunAddress, recipient: publicOwner.address,
    minimum: '188188', fromBlock: 90, nullifiers: [id('saved withdrawal input')],
    transaction: { to: proxy, data, value: '0' }, minGasPrice }
  state.privateWithdrawal = structuredClone(withdrawal)
  const head = { number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 20_000_000n }
  const provider = { ...session.provider, getNetwork: vi.fn(async () => ({ chainId: 42161n })),
    getBlock: vi.fn(async (_tag: string | number) => ({ ...head })), getTransactionCount: vi.fn(async () => 7),
    getCode: vi.fn(async () => '0x'), getRpcTransaction: JsonRpcProvider.prototype.getRpcTransaction,
    send: vi.fn(async (method: string, _params: unknown[]): Promise<unknown> => {
      if (method !== 'eth_estimateGas') throw new Error('Forbidden RPC method')
      return '0x79006'
    }) }
  const renewalSession = { ...session, provider } as unknown as WalletSession
  state.send.mockImplementation(async packet => {
    const envelope = JSON.parse(packet.params.encryptedData[0])
    if (envelope.authorization) {
      const authorized = authenticateCreditRequest(scope(), ledgerId, envelope.authorization)
      if (authorized.payload.kind === 'recover') {
        expect(authorized.payload).toEqual({ kind: 'recover', operation: 'execute', sequence: 1,
          payloadHash: keccak256(toUtf8Bytes(original.payload)) })
        state.nextSequence = 2
        state.events.push('retired')
        respond(packet, envelope, { kind: 'recovery', recoveredKey: original.key, operation: 'execute',
          state: 'not-reserved', sequence: 1, retiredThrough: 1 }, authorized.key)
        return
      }
      if (authorized.payload.kind === 'execute') state.events.push('execute')
    }
    return server(packet)
  })
  return { session: renewalSession, provider, original, withdrawal, request, head }
}

it('waits for browser history before retiring or quoting the saved withdrawal', async () => {
  const f = renewalFixture(), before = structuredClone(state.record)
  let complete!: () => void
  state.ensureSync.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
  const review = prepareSavedPrepaidWithdrawal(f.session)
  await vi.waitFor(() => expect(state.ensureSync).toHaveBeenCalledExactlyOnceWith(f.session))
  expect(state.send).not.toHaveBeenCalled()
  expect(state.record).toEqual(before)
  complete()
  await review
  expect(state.events).toEqual(['retired', 'saved'])
  expect(state.messages.some(message => message.kind === 'execute')).toBe(false)
})

it('preserves proof and credit without contacting the broadcaster if history verification fails', async () => {
  const f = renewalFixture(), before = structuredClone(state.record)
  state.ensureSync.mockRejectedValueOnce(new Error('Private history verification is incomplete.'))
  await expect(prepareSavedPrepaidWithdrawal(f.session)).rejects.toThrow('verification is incomplete')
  expect(state.send).not.toHaveBeenCalled()
  expect(state.record).toEqual(before)
  expect(state.privateWithdrawal).toEqual(f.withdrawal)
  expect(state.events).toEqual([])
})

it('reviews a retired COMMON proof with a fresh pinned estimate and submits only on explicit confirmation', async () => {
  const f = renewalFixture(), prepared = await prepareSavedPrepaidWithdrawal(f.session)
  expect(state.events).toEqual(['retired', 'saved'])
  expect(state.record).toHaveProperty('completed.attempt.payload', f.original.payload)
  expect(state.record).not.toHaveProperty('attempt')
  expect(state.privateWithdrawal).toEqual(f.withdrawal)
  expect(prepared.previousKey).toBe(f.original.key)
  expect(prepared.credit.nextSequence).toBe(2)
  expect(prepared.gas).toEqual({ evmGasType: 1, gasEstimate: 495622n, gasPrice: 22_000_001n })
  expect(f.provider.send).toHaveBeenCalledExactlyOnceWith('eth_estimateGas', [{ chainId: '0xa4b1', type: '0x1',
    from: state.policy.operator.toLowerCase(), to: proxy.toLowerCase(), data: f.request.data, nonce: '0x7',
    value: '0x0', gasPrice: '0x14fb181' }, '0x64'])
  expect(f.provider.getBlock.mock.calls).toEqual([['latest'], [100]])
  expect(await confirmSavedPrepaidWithdrawal(f.session, prepared)).toBe(hash)
  expect(state.events).toEqual(['retired', 'saved', 'saved', 'execute', 'saved', 'withdrawal-saved'])
  const record = state.record as { attempt: { payload: string; hash: string }; completed: { attempt: unknown } }
  expect(record.completed.attempt).toEqual({ ...f.original, state: 'not-reserved' })
  const replacement = JSON.parse(record.attempt.payload)
  expect(replacement).toMatchObject({ kind: 'execute', sequence: 2, collectionAllowance: '0',
    maximumCharge: prepaidAttemptFee(prepared.credit, prepared.gas).toString(),
    request: { ...f.request, feesID: prepared.credit.feesID, minGasPrice: prepared.gas.gasPrice.toString() } })
  expect(record.attempt.hash).toBe(hash)
  expect(state.privateWithdrawal).toEqual({ ...f.withdrawal, hash })
  expect(state.signPublic).not.toHaveBeenCalled()
  await expect(confirmSavedPrepaidWithdrawal(f.session, prepared)).rejects.toThrow('Review')
})

it.each(['reserved', 'unknown', 'wrong-retirement'])('does not renew on %s old request status', async mode => {
  const f = renewalFixture(), before = structuredClone(state.record)
  state.send.mockImplementation(async packet => {
    const envelope = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, envelope.authorization)
    respond(packet, envelope, mode === 'wrong-retirement'
      ? { kind: 'recovery', recoveredKey: id('wrong'), operation: 'execute', state: 'not-reserved', sequence: 1, retiredThrough: 1 }
      : { kind: 'attempt', state: mode === 'reserved' ? 'reserved-before-signing' : 'submitted-or-unknown', nonce: 7, charged: null }, authorized.key)
  })
  await expect(prepareSavedPrepaidWithdrawal(f.session)).rejects.toThrow()
  expect(f.provider.send).not.toHaveBeenCalled()
  expect(state.privateWithdrawal).toEqual(f.withdrawal)
  expect(state.record).not.toHaveProperty('completed')
  if (mode === 'wrong-retirement') expect(state.record).toEqual(before)
  else {
    expect(state.record).toHaveProperty('attempt.nonce', 7)
    expect(state.record).toHaveProperty('attempt.state', mode === 'reserved' ? 'reserved-before-signing' : 'submitted-or-unknown')
    expect(state.record).toHaveProperty('attempt.payload', f.original.payload)
  }
  expect(state.signPublic).not.toHaveBeenCalled()
})

it.each([{ nonce: 0 }, { nonce: 3 }, { hash }, { state: 'reserved-before-signing' },
  { state: 'submitted-or-unknown' }, { state: 'settled' }])('exposes a held fee request without changing it and directs renewal to recovery: %j', async held => {
  const f = renewalFixture()
  Object.assign((state.record as { attempt: object }).attempt, held)
  const before = structuredClone(state.record)
  expect(await pendingPrepaid(f.session, 'native')).toMatchObject({ key: f.original.key, reserved: true })
  await expect(prepareSavedPrepaidWithdrawal(f.session)).rejects.toThrow('Check fee-credit transaction')
  expect(state.record).toEqual(before)
  expect(state.privateWithdrawal).toEqual(f.withdrawal)
  expect(state.send).not.toHaveBeenCalled()
  expect(f.provider.send).not.toHaveBeenCalled()
  expect(state.events).toEqual([])
})

it('keeps a never-reserved or retired fee request eligible for explicit review', async () => {
  const f = renewalFixture()
  expect(await pendingPrepaid(f.session, 'native')).toMatchObject({ reserved: false })
  await prepareSavedPrepaidWithdrawal(f.session)
  expect(await pendingPrepaid(f.session, 'native')).toMatchObject({ reserved: false, state: 'not-reserved', completed: true })
})

it.each(['recipient', 'token', 'inputs', 'data', 'hash', 'bound', 'chain', 'swap'])('rejects changed %s before retiring the old request', async change => {
  const f = renewalFixture(), withdrawal = state.privateWithdrawal as typeof f.withdrawal & { hash?: string; execution?: object }
  if (change === 'recipient') withdrawal.recipient = owner.address
  if (change === 'token') withdrawal.token = 'WETH' as 'USDC'
  if (change === 'inputs') withdrawal.nullifiers = [id('other')]
  if (change === 'data') withdrawal.transaction.data += '00'
  if (change === 'hash') withdrawal.hash = hash
  if (change === 'bound') withdrawal.execution = {}
  if (change === 'chain') state.chainId = 1
  if (change === 'swap') state.privateSwap = { account: owner.address }
  await expect(prepareSavedPrepaidWithdrawal(f.session)).rejects.toThrow()
  expect(state.send).not.toHaveBeenCalled()
  expect(f.provider.send).not.toHaveBeenCalled()
})

it.each(['0x0', '0x00', '0x01', 495622, null, `0x1${'0'.repeat(64)}`, '0x7a1200'])('retains proof and retired fee record on invalid estimate %#', async estimate => {
  const f = renewalFixture()
  f.provider.send.mockResolvedValue(estimate)
  await expect(prepareSavedPrepaidWithdrawal(f.session)).rejects.toThrow('gas estimate')
  expect(state.record).toHaveProperty('completed.attempt.payload', f.original.payload)
  expect(state.record).not.toHaveProperty('attempt')
  expect(state.privateWithdrawal).toEqual(f.withdrawal)
  expect(state.events).not.toContain('execute')
})

it.each(['reorg', 'stale', 'price', 'spent', 'insufficient'])('requires a valid %s review without a new financial attempt', async failure => {
  const f = renewalFixture()
  if (failure === 'reorg') f.provider.getBlock.mockImplementation(async tag => ({ ...f.head, hash: tag === 'latest' ? blockHash : id('reorg') }))
  if (failure === 'stale') f.head.timestamp -= 46
  if (failure === 'price') f.head.baseFeePerGas = state.policy.maxGasPrice
  if (failure === 'spent') state.inputSpent.mockResolvedValue(true)
  if (failure === 'insufficient') state.available = '1'
  await expect(prepareSavedPrepaidWithdrawal(f.session)).rejects.toThrow()
  expect(state.record).toHaveProperty('completed.attempt.payload', f.original.payload)
  expect(state.record).not.toHaveProperty('attempt')
  expect(state.privateWithdrawal).toEqual(f.withdrawal)
  expect(state.events).not.toContain('execute')
})

it.each([
  ['rounding', '20000000', 20_000_001n, 22_000_003n],
  ['saved minimum', '25000000', 20_000_000n, 25_000_000n],
  ['operator ceiling', '20000000', 490_000_000n, 500_000_000n],
] as const)('keeps price headroom within the %s constraint', async (_case, minimum, baseFee, expected) => {
  const f = renewalFixture(minimum)
  f.head.baseFeePerGas = baseFee
  const prepared = await prepareSavedPrepaidWithdrawal(f.session)
  expect(prepared.gas.gasPrice).toBe(expected)
  expect(prepared.gas.gasPrice).toBeLessThanOrEqual(prepared.credit.maximumGasPrice)
  expect(state.events).not.toContain('execute')
})

it('refuses a saved gas floor above the operator ceiling instead of lowering it', async () => {
  const f = renewalFixture('600000000')
  await expect(prepareSavedPrepaidWithdrawal(f.session)).rejects.toThrow('gas pricing exceeds')
  expect(state.privateWithdrawal).toEqual(f.withdrawal)
  expect(state.events).not.toContain('execute')
})

it.each([20_000_001n, 21_000_000n, 22_000_000n])('keeps the reviewed fee unchanged through a base fee increase to %s wei', async baseFee => {
  const f = renewalFixture(), prepared = await prepareSavedPrepaidWithdrawal(f.session)
  const approvedCharge = prepaidAttemptFee(prepared.credit, prepared.gas)
  f.head.baseFeePerGas = baseFee
  await expect(confirmSavedPrepaidWithdrawal(f.session, prepared)).resolves.toBe(hash)
  const stored = state.record as { attempt: { payload: string } }
  const payload = JSON.parse(stored.attempt.payload)
  expect(payload.maximumCharge).toBe(approvedCharge.toString())
  expect(payload.request.minGasPrice).toBe(prepared.gas.gasPrice.toString())
  expect(state.events.filter(event => event === 'execute')).toHaveLength(1)
})

it.each(['cap', 'proof', 'journal', 'retirement', 'identity', 'spent', 'price', 'expired'])('rechecks %s on confirm and never silently renews consent', async change => {
  const f = renewalFixture(), prepared = await prepareSavedPrepaidWithdrawal(f.session)
  if (change === 'cap') prepared.credit.rate++
  if (change === 'proof') prepared.withdrawal.transaction.data += '00'
  if (change === 'journal') (state.privateWithdrawal as typeof f.withdrawal).minimum = '1'
  if (change === 'retirement') (state.record as { completed: { attempt: { payload: string; key: string } } }).completed.attempt.key = id('changed')
  if (change === 'identity') (state.record as { ledgerId: string }).ledgerId = id('other ledger')
  if (change === 'spent') state.inputSpent.mockResolvedValue(true)
  if (change === 'price') f.head.baseFeePerGas = prepared.gas.gasPrice
  if (change === 'expired') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 200_000); f.head.timestamp = Math.floor(Date.now() / 1000) }
  const before = structuredClone(state.record)
  await expect(confirmSavedPrepaidWithdrawal(f.session, prepared)).rejects.toThrow()
  expect(state.record).toEqual(before)
  expect(state.events).not.toContain('execute')
})

it('preserves both journals and exact renewed bytes after lost acknowledgement, then retries only those bytes', async () => {
  const f = renewalFixture(), prepared = await prepareSavedPrepaidWithdrawal(f.session), send = state.send.getMockImplementation()!
  let droppedPayload = ''
  state.send.mockImplementation(async packet => {
    const envelope = JSON.parse(packet.params.encryptedData[0])
    if (envelope.authorization && JSON.parse(envelope.authorization.payload).kind === 'execute') {
      droppedPayload = envelope.authorization.payload
      throw new Error('Synthetic relay failure')
    }
    return send(packet)
  })
  await expect(confirmSavedPrepaidWithdrawal(f.session, prepared)).rejects.toThrow()
  expect(droppedPayload).not.toBe('')
  expect(state.record).toHaveProperty('attempt.payload', droppedPayload)
  expect(state.record).toHaveProperty('completed.attempt.payload', f.original.payload)
  expect(state.privateWithdrawal).toEqual(f.withdrawal)
  state.send.mockImplementation(async packet => {
    const envelope = JSON.parse(packet.params.encryptedData[0])
    expect(envelope.authorization.payload).toBe(droppedPayload)
    return server(packet)
  })
  expect(await retryPrepaid(f.session, 'native')).toBe(hash)
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('does not send a renewed execution if persistence fails and coalesces no concurrent confirmation', async () => {
  const f = renewalFixture(), prepared = await prepareSavedPrepaidWithdrawal(f.session)
  const before = structuredClone(state.record)
  let release!: () => void
  state.inputSpent.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(false) }))
  const first = confirmSavedPrepaidWithdrawal(f.session, prepared)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await expect(confirmSavedPrepaidWithdrawal(f.session, prepared)).rejects.toThrow('already running')
  state.writeError = true; release()
  await expect(first).rejects.toThrow('storage quota')
  expect(state.record).toEqual(before)
  expect(state.privateWithdrawal).toEqual(f.withdrawal)
  expect(state.events).not.toContain('execute')
})

it('inspects the saved Arbitrum request without authorizing, signing or writing either journal', async () => {
  state.chainId = 42161; state.policy.funding = 'native'
  const payload = JSON.stringify({ kind: 'execute', request: { to: owner.address, data: '0xaabb' } })
  state.record = { scope: scope(), ledgerId, owner: owner.address,
    attempt: { payload, key: creditRequestKey(ledgerId, owner.address, payload), rate: (10n ** 18n).toString() } }
  state.privateSwap = { account: owner.address, feeMode: 'prepaid' }
  const before = structuredClone(state.record)
  expect(await diagnosePrepaidTransaction(session)).toBe('historical diagnostic')
  expect(state.diagnose).toHaveBeenCalledWith(session.provider, JSON.parse(payload).request, state.privateSwap,
    state.policy.operator, '0x5fa18eD9d36Fe8e6e30aCD4f894Df9C05913aB5E')
  expect(state.record).toEqual(before)
  expect(state.events).toEqual([])
  expect(state.send).not.toHaveBeenCalled()
  expect(state.signPublic).not.toHaveBeenCalled()
  state.privateSwap = { ...state.privateSwap as object, hash }
  await expect(diagnosePrepaidTransaction(session)).rejects.toThrow('unsubmitted')
  state.chainId = 1
  await expect(diagnosePrepaidTransaction(session)).rejects.toThrow('Arbitrum pilot')
  expect(state.diagnose).toHaveBeenCalledTimes(1)
})

it('inspects a saved withdrawal without authorizing, signing, submitting or changing its saved records', async () => {
  state.chainId = 42161; state.policy.funding = 'native'
  const payload = JSON.stringify({ kind: 'execute', request: { to: proxy, data: '0xaabb' } })
  state.record = { scope: scope(), ledgerId, owner: owner.address,
    attempt: { payload, key: creditRequestKey(ledgerId, owner.address, payload), rate: (10n ** 18n).toString() } }
  state.privateWithdrawal = { feeMode: 'prepaid', transaction: { to: proxy, data: '0xaabb' } }
  const before = structuredClone({ record: state.record, withdrawal: state.privateWithdrawal })
  expect(await diagnosePrepaidTransaction(session)).toBe('historical diagnostic')
  expect(state.diagnose).toHaveBeenCalledWith(session.provider, JSON.parse(payload).request, state.privateWithdrawal,
    state.policy.operator, '0x5fa18eD9d36Fe8e6e30aCD4f894Df9C05913aB5E')
  expect({ record: state.record, withdrawal: state.privateWithdrawal }).toEqual(before)
  expect(state.events).toEqual([]); expect(state.send).not.toHaveBeenCalled(); expect(state.signPublic).not.toHaveBeenCalled()
  state.privateSwap = { feeMode: 'prepaid' }
  await expect(diagnosePrepaidTransaction(session)).rejects.toThrow('unsubmitted')
  expect(state.diagnose).toHaveBeenCalledTimes(1)
})

it('uses opaque public native prepayment without generating a private transfer proof', async () => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  expect(credit.collectionAllowance).toBe(0n)
  expect(prepaidRefundFee(credit)).toBe(11_000n)
  expect(credit.selected.railgunAddress).toBe(state.policy.railgunAddress)
  expect((await prepaidBalance(session)).available).toBe(2_000_000_000_000_000n)
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).resolves.toBe(hash)
  const tx = state.signPublic.mock.calls[0][0]
  expect(tx).toMatchObject({ to: state.policy.operator, value: 100_000n, chainId: 1n, nonce: 0 })
  expect(tx.data).toHaveLength(130)
  expect(tx.data.toLowerCase()).not.toContain(owner.address.slice(2).toLowerCase())
  expect(state.events).not.toContain('proved')
  expect(state.events.indexOf('saved')).toBeLessThan(state.events.indexOf('public'))
  vi.mocked(session.provider.getTransaction).mockResolvedValue({ ...tx, hash, from: publicOwner.address } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  state.finalized = 98
  await expect(claimPrepaidTopUp(session)).rejects.toThrow('not finalized')
  state.finalized = 100
  expect((await claimPrepaidTopUp(session)).available).toBeGreaterThan(0n)
  const claim = JSON.parse((state.messages.at(-1)!.authorization as { payload: string }).payload)
  expect(claim).toMatchObject({ kind: 'claim', transactionHash: hash, paymentId: expect.stringMatching(/^0x[0-9a-f]{64}$/) })
  expect((await pendingPrepaid(session))?.topUpPending).toBe(false)
})

it('starts native credit in a separate encrypted journal while preserving the old private-credit record', async () => {
  await preparePrepaid(session)
  const legacy = structuredClone(state.record)
  expect(state.recordKey).toBe('prepaidCredit')
  state.policy.funding = 'native'
  expect((await preparePrepaid(session)).scope.funding).toBe('native')
  expect(state.recordKey).toBe('nativePrepaidCredit')
  expect(state.records.get('prepaidCredit')).toEqual(legacy)
  state.policy.funding = undefined
  expect((await prepaidBalance(session)).funding).toBeUndefined()
})

it.each(['execute', 'refund', 'top-up'] as const)('recovers an earlier %s under native policy without rewriting either ledger identity', async (operation) => {
  const credit = operation === 'refund'
    ? (await prepaidBalance(session), await preparePrepaidRefund(session)) : await preparePrepaid(session)
  if (operation === 'top-up') await topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)
  else {
    state.send.mockImplementation(async packet => {
      const request = JSON.parse(packet.params.encryptedData[0])
      if (request.authorization && JSON.parse(request.authorization.payload).kind === operation) throw new Error('Unknown submission')
      return server(packet)
    })
    await expect(operation === 'execute' ? submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)
      : requestPrepaidRefund(session, credit, 100_000n)).rejects.toThrow('Unknown submission')
  }
  const legacy = structuredClone(state.record) as { scope: ReturnType<typeof scope>; ledgerId: string;
    attempt?: { key: string }; refund?: { key: string } }
  state.policy.funding = 'native'
  await preparePrepaid(session)
  const native = structuredClone(state.records.get('nativePrepaidCredit'))
  expect(await pendingPrepaid(session, 'private')).toMatchObject(operation === 'top-up' ? { topUpPending: true }
    : operation === 'refund' ? { refundPending: true } : { key: legacy.attempt!.key })
  expect(await pendingPrepaid(session)).toMatchObject({ topUpPending: false, refundPending: false })
  state.signPublic.mockClear()
  state.send.mockImplementation(async packet => {
    const request = JSON.parse(packet.params.encryptedData[0])
    expect(request.kind).not.toBe('info')
    expect(() => authenticateCreditRequest(scope(), ledgerId, request.authorization)).toThrow()
    const authorized = authenticateCreditRequest(legacy.scope, legacy.ledgerId, request.authorization)
    if (authorized.payload.kind === 'refund') throw new Error('Original execution admission is paused')
    const body = authorized.payload.kind === 'recover'
      ? { kind: 'recovery', recoveredKey: (legacy.attempt ?? legacy.refund)!.key, operation, state: 'not-reserved', sequence: 1, retiredThrough: 1 }
      : { kind: 'balance', owner: owner.address, memo: creditMemo(legacy.scope, legacy.ledgerId, owner.address),
        available: '1000', deposited: '1000', charged: '0', reserved: '0', refunds: '0' }
    respond(packet, request, body, authorized.key)
  })
  expect((await prepaidBalance(session, 'private')).available).toBe(1000n)
  if (operation === 'top-up') expect((await claimPrepaidTopUp(session, undefined, 'private')).available).toBe(1000n)
  else await expect(operation === 'execute' ? checkPrepaid(session, 'private') : checkPrepaidRefund(session, 'private'))
    .resolves.toMatchObject({ state: 'not-reserved' })
  expect(state.policy.funding).toBe('native')
  expect(state.records.get('nativePrepaidCredit')).toEqual(native)
  expect((state.records.get('prepaidCredit') as { scope: unknown }).scope).toEqual(legacy.scope)
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('preserves both journals when the original ledger is unavailable and rejects cross-mode stored identities', async () => {
  await preparePrepaid(session)
  const legacy = structuredClone(state.record)
  state.policy.funding = 'native'
  await preparePrepaid(session)
  const native = structuredClone(state.record)
  state.send.mockRejectedValue(new Error('Original ledger unavailable'))
  await expect(prepaidBalance(session, 'private')).rejects.toThrow('Original ledger unavailable')
  expect(state.records.get('prepaidCredit')).toEqual(legacy)
  expect(state.records.get('nativePrepaidCredit')).toEqual(native)
  state.records.set('prepaidCredit', native)
  await expect(pendingPrepaid(session, 'private')).rejects.toThrow('funding mode changed')
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('retries only the exact legacy authorization without creating new legacy credit under native policy', async () => {
  const credit = await preparePrepaid(session)
  await submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)
  const original = structuredClone(state.record) as { scope: ReturnType<typeof scope>; ledgerId: string;
    attempt: { payload: string; key: string } }
  state.policy.funding = 'native'
  await preparePrepaid(session)
  const native = structuredClone(state.record)
  state.send.mockImplementation(async packet => {
    const request = JSON.parse(packet.params.encryptedData[0])
    const authorized = authenticateCreditRequest(original.scope, original.ledgerId, request.authorization)
    expect(authorized.authorization.payload).toBe(original.attempt.payload)
    expect(authorized.key).toBe(original.attempt.key)
    respond(packet, request, { txHash: hash }, authorized.key)
  })
  await expect(retryPrepaid(session, 'private')).resolves.toBe(hash)
  expect(state.records.get('nativePrepaidCredit')).toEqual(native)
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('scope changed')
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).rejects.toThrow('scope changed')
  expect(state.signPublic).not.toHaveBeenCalled()
})

it.each(['0x6000', '0xef0100', `0xef0100${'ab'.repeat(19)}`, `0xef0100${'ab'.repeat(21)}`,
  `0xef0101${'ab'.repeat(20)}`, `0xef0100${'zz'.repeat(20)}`])('rejects unsupported payer code %s before asking for a native payment', async (code) => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  vi.mocked(publicSigner.provider.getCode).mockResolvedValue(code)
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('This wallet cannot send the direct fee payment')
  expect(state.signPublic).not.toHaveBeenCalled()
  expect(state.record).not.toHaveProperty('topUp')
})

it('accepts an exact EIP-7702 payer designation for a direct type2 payment and same-nonce retry', async () => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  vi.mocked(publicSigner.provider.getCode).mockResolvedValue(`0xef0100${'ab'.repeat(20)}`)
  state.signPublic.mockRejectedValueOnce(new Error('Wallet result lost'))
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('lost')
  const original = state.signPublic.mock.calls[0][0]
  expect(original).toMatchObject({ to: state.policy.operator, value: 100_000n, type: 2, chainId: 1n, nonce: 0 })
  expect(original).not.toHaveProperty('authorizationList')
  await expect(retryPrepaidTopUp(session, publicSigner, () => {})).resolves.toBe(hash)
  expect(state.signPublic.mock.calls[1][0]).toEqual(original)
  vi.mocked(session.provider.getTransaction).mockResolvedValue({ ...original, hash, from: publicOwner.address } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  await expect(claimPrepaidTopUp(session)).resolves.toMatchObject({ available: 2_000_000_000_000_000n })
})

it.each(['fresh', 'retry'])('still rejects delegated operator code before a %s native payment', async (operation) => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  if (operation === 'retry') {
    state.signPublic.mockRejectedValueOnce(new Error('Unknown'))
    await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('Unknown')
    state.signPublic.mockClear()
  }
  vi.mocked(session.provider.getCode).mockResolvedValue(`0xef0100${'ab'.repeat(20)}`)
  await expect(operation === 'fresh' ? topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)
    : retryPrepaidTopUp(session, publicSigner, () => {})).rejects.toThrow('The broadcaster cannot accept this payment')
  expect(state.signPublic).not.toHaveBeenCalled()
  if (operation === 'fresh') expect(state.record).not.toHaveProperty('topUp')
  else expect(state.record).toHaveProperty('topUp')
})

it('rejects changed contract payer code on retry while preserving the saved payment', async () => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  state.signPublic.mockRejectedValueOnce(new Error('Unknown'))
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('Unknown')
  state.signPublic.mockClear()
  vi.mocked(publicSigner.provider.getCode).mockResolvedValue('0x6000')
  await expect(retryPrepaidTopUp(session, publicSigner, () => {})).rejects.toThrow('This wallet cannot send the direct fee payment')
  expect(state.signPublic).not.toHaveBeenCalled()
  expect((await pendingPrepaid(session))?.topUpPending).toBe(true)
})

it('recovers a lost native payment hash only for the saved sender and exact payment', async () => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  state.signPublic.mockRejectedValueOnce(new Error('Wallet result lost'))
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('lost')
  const saved = (state.record as { topUp: { transaction: { to: string; data: string; value: string }; nonce: number } }).topUp
  const tx = { ...saved.transaction, value: 100_000n, from: publicOwner.address, chainId: 1n, nonce: saved.nonce, hash, type: 2 }
  for (const change of [{ value: 99_999n }, { from: owner.address }, { data: '0x' }, { chainId: 56n },
    { type: 1 }, { type: 4 }, { authorizationList: [{}] }, { to: publicOwner.address }]) {
    vi.mocked(session.provider.getTransaction).mockResolvedValue({ ...tx, ...change } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
    await expect(claimPrepaidTopUp(session, hash)).rejects.toThrow('does not match')
    expect((await pendingPrepaid(session))?.topUpPending).toBe(true)
  }
  // A wallet may override the requested nonce; a finalized exact payment is still claimable.
  vi.mocked(session.provider.getTransaction).mockResolvedValue({ ...tx, nonce: saved.nonce + 1 } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  await expect(claimPrepaidTopUp(session, hash)).resolves.toMatchObject({ available: 2_000_000_000_000_000n })
})

it('retries unknown native payment with its same nonce and amount, never a second payment', async () => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  state.signPublic.mockRejectedValueOnce(new Error('Unknown'))
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('Unknown')
  const original = state.signPublic.mock.calls[0][0]
  await expect(retryPrepaidTopUp(session, publicSigner, () => {})).resolves.toBe(hash)
  expect(state.signPublic.mock.calls[1][0]).toEqual(original)
})

it.each(['refunded', 'failed'])('binds native refund destination and retains the record until valid %s accounting', async (terminal) => {
  state.policy.funding = 'native'
  await preparePrepaid(session)
  const credit = await preparePrepaidRefund(session)
  await expect(requestPrepaidRefund(session, credit, 100_000n, state.policy.operator)).rejects.toThrow('different from the broadcaster')
  let final = false, invalid = false
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    const payload = authorized.payload
    respond(packet, request, { kind: 'refund', recipient: payload.recipient, gross: payload.gross, net: payload.net,
      state: final ? terminal : 'submitted-or-unknown', nonce: 10, transactionHash: hash, settlementHash: final ? hash : null,
      cancellationHash: null, charged: final ? invalid ? '100001' : terminal === 'refunded' ? '90100' : '1100' : null,
      netPaid: final ? terminal === 'refunded' ? payload.net : '0' : null }, authorized.key)
  })
  const refund = await requestPrepaidRefund(session, credit, 100_000n, publicOwner.address)
  expect(JSON.parse((state.record as { refund: { payload: string } }).refund.payload))
    .toMatchObject({ refundGasAllowance: '10000', collectionAllowance: '0' })
  expect(refund).toMatchObject({ recipient: publicOwner.address, net: 89_000n, state: 'submitted-or-unknown' })
  expect((await pendingPrepaid(session))?.refundPending).toBe(true)
  final = true; invalid = true
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).rejects.toThrow('Reconcile')
  await expect(checkPrepaidRefund(session)).rejects.toThrow('accounting')
  expect((await pendingPrepaid(session))?.refundPending).toBe(true)
  invalid = false
  vi.mocked(session.provider.getTransaction).mockResolvedValue({ from: state.policy.operator, to: publicOwner.address,
    data: '0x', value: 89_000n, chainId: 1n, hash, nonce: 10 } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  state.receiptStatus = terminal === 'refunded' ? 1 : 0
  state.finalized = 98
  await expect(checkPrepaidRefund(session)).rejects.toThrow('not finalized')
  expect((await pendingPrepaid(session))?.refundPending).toBe(true)
  state.finalized = 100
  expect((await checkPrepaidRefund(session)).state).toBe(terminal)
  expect((await pendingPrepaid(session))?.refundPending).toBe(false)
})

it('does not retire an acknowledged native refund and accepts an older mined cancellation only at its original nonce', async () => {
  state.policy.funding = 'native'
  await preparePrepaid(session)
  const credit = await preparePrepaidRefund(session)
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), auth = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    respond(packet, request, { kind: 'refund', recipient: publicOwner.address, gross: '100000', net: '89000',
      state: 'submitted-or-unknown', nonce: 10, transactionHash: hash, settlementHash: null, charged: null, netPaid: null }, auth.key)
  })
  await requestPrepaidRefund(session, credit, 100_000n, publicOwner.address)
  const original = structuredClone((state.record as { refund: { key: string; payload: string } }).refund)
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), auth = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    if (auth.payload.kind === 'refund') throw new Error('Lost state')
    respond(packet, request, { kind: 'recovery', recoveredKey: original.key, operation: 'refund', sequence: 1, retiredThrough: 1, state: 'not-reserved' }, auth.key)
  })
  await expect(checkPrepaidRefund(session)).rejects.toThrow('acknowledged refund')
  expect((await pendingPrepaid(session))?.refundPending).toBe(true)
  const older = id('earlier cancellation'), latest = id('latest cancellation')
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), auth = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    respond(packet, request, { kind: 'refund', recipient: publicOwner.address, gross: '100000', net: '89000',
      state: 'failed', nonce: 10, transactionHash: hash, cancellationHash: latest, settlementHash: older, charged: '1100', netPaid: '0' }, auth.key)
  })
  vi.mocked(session.provider.getTransaction).mockImplementation(async (requested) => ({ hash: requested, from: state.policy.operator,
    to: requested === hash ? publicOwner.address : state.policy.operator, value: requested === hash ? 89_000n : 0n,
    data: '0x', chainId: 1n, nonce: 10 } as Awaited<ReturnType<typeof session.provider.getTransaction>>))
  expect((await checkPrepaidRefund(session)).state).toBe('failed')
  expect((await pendingPrepaid(session))?.refundPending).toBe(false)
})

it('checks actual native attempt gas charges and saved execution before releasing the client record', async () => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  await submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)
  let charge = '1200'
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), auth = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    respond(packet, request, { kind: 'attempt', hash, nonce: 3, settlementHash: hash, cancellationHash: null, state: 'settled', charged: charge }, auth.key)
  })
  vi.mocked(session.provider.getTransaction).mockResolvedValue({ from: state.policy.operator, to: proxy, data: '0xaabb', value: 0n,
    chainId: 1n, nonce: 3, hash } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  await expect(checkPrepaid(session)).rejects.toThrow('actual gas')
  charge = '1100'
  vi.mocked(session.provider.getTransaction).mockResolvedValueOnce({ from: state.policy.operator, to: proxy, data: '0xaacc', value: 0n,
    chainId: 1n, nonce: 3, hash } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  await expect(checkPrepaid(session)).rejects.toThrow('saved request')
  expect((await checkPrepaid(session)).charged).toBe(1100n)
})

it('authenticates the pinned scope and signs credit queries with account zero without funding it', async () => {
  const credit = await preparePrepaid(session)
  expect(credit.scope).toEqual(scope())
  expect(credit.owner).toBe(owner.address)
  expect(credit.nextSequence).toBe(1)
  expect(await prepaidBalance(session)).toMatchObject({ available: 2_000_000_000_000_000n, reserved: 0n })
  expect(session.accounts.getAccount).toHaveBeenCalledWith(1n, 0)
  expect(state.signPublic).not.toHaveBeenCalled()
  expect(prepaidAttemptFee(credit, gas)).toBe(13_211_000n)
})

it.each([undefined, null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER])('rejects quote sequence %s before preparing an operation', async (sequence) => {
  state.nextSequence = sequence as number
  await expect(preparePrepaid(session)).rejects.toThrow('request sequence')
  expect(state.record).not.toHaveProperty('attempt')
  expect(state.record).not.toHaveProperty('refund')
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('ignores an encrypted response with the wrong protocol, correlation or request key', async () => {
  state.send.mockImplementationOnce(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0])
    const wrong = { protocol: 'wrong', correlation: request.correlation, key: id('wrong'), scope: scope(), ledgerId }
    state.callback?.({ payload: toUtf8Bytes(JSON.stringify({ id: packet.id, result: [JSON.stringify(wrong), packet.params.encryptedData[1]] })) })
    await server(packet)
  })
  expect((await preparePrepaid(session)).ledgerId).toBe(ledgerId)
})

it('reports an authenticated pre-authorization rejection instead of timing out on the envelope key', async () => {
  state.send.mockImplementation(async packet => {
    const request = JSON.parse(packet.params.encryptedData[0])
    if (request.kind === 'info') return server(packet)
    respond(packet, request, { error: 'Prepaid request rejected. Keep the saved attempt.' })
  })
  await expect(preparePrepaid(session)).rejects.toThrow('Prepaid fee quote: Prepaid request rejected')
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('never accepts signed-request success under the transport key or an error under an unrelated key', async () => {
  vi.useFakeTimers()
  state.send.mockImplementation(async packet => {
    const request = JSON.parse(packet.params.encryptedData[0])
    if (request.kind === 'info') return server(packet)
    respond(packet, request, { kind: 'quote' })
    respond(packet, request, { error: 'Wrong-key error' }, id('unrelated-key'))
  })
  const failure = expect(preparePrepaid(session)).rejects.toThrow('Prepaid fee quote response timed out')
  await vi.advanceTimersByTimeAsync(45_000); await failure
})

it('repairs a missing response topic on the same core before another request', async () => {
  await preparePrepaid(session)
  state.subscriptions.clear()
  await expect(preparePrepaid(session)).resolves.toHaveProperty('ledgerId', ledgerId)
  expect(state.subscribe).toHaveBeenCalledTimes(2)
})

it('does not reuse an old core subscription promise for a replacement core', async () => {
  let release!: () => void
  state.subscribe.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const old = preparePrepaid(session), rejected = expect(old).rejects.toThrow('service discovery connection changed')
  await vi.waitFor(() => expect(state.subscribe).toHaveBeenCalledTimes(1))
  state.core = {}
  await expect(preparePrepaid(session)).resolves.toHaveProperty('ledgerId', ledgerId)
  release(); await rejected
  expect(state.subscribe).toHaveBeenCalledTimes(2)
  expect(state.messages).toHaveLength(2)
})

it('refuses disclosure when the core changes while an execution request is encrypted', async () => {
  const credit = await preparePrepaid(session), encrypt = state.encrypt.getMockImplementation()!
  state.encrypt.mockImplementation(async data => {
    if (data.authorization?.payload.includes('"kind":"execute"')) state.core = {}
    return encrypt(data)
  })
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).rejects.toThrow('transaction submission connection changed')
  expect((await pendingPrepaid(session))?.key).toBeTruthy()
  expect(state.messages.some(message => (message.authorization as { payload: string } | undefined)?.payload.includes('"kind":"execute"'))).toBe(false)
  expect(state.signPublic).not.toHaveBeenCalled()
})

it.each(['execute', 'refund'])('rejects an in-flight %s on restart, retaining exact consent without automatic replay', async operation => {
  const executionCredit = await preparePrepaid(session)
  const credit = operation === 'refund' ? await preparePrepaidRefund(session) : executionCredit
  const publications = () => state.send.mock.calls.filter(([packet]) => {
    const payload = JSON.parse(packet.params.encryptedData[0]).authorization?.payload
    return payload && JSON.parse(payload).kind === operation
  })
  state.send.mockImplementation(async packet => {
    const request = JSON.parse(packet.params.encryptedData[0])
    if (!request.authorization?.payload.includes(`"kind":"${operation}"`)) return server(packet)
    state.core = {}; state.subscriptions.clear(); state.restart!()
  })
  await expect(operation === 'execute'
    ? submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)
    : requestPrepaidRefund(session, credit, 100_000n)).rejects.toThrow(`${operation === 'execute' ? 'transaction' : 'refund'} submission connection changed`)
  expect(publications()).toHaveLength(1)
  const saved = (state.record as { attempt?: { payload: string }; refund?: { payload: string } })[operation === 'execute' ? 'attempt' : 'refund']
  expect(JSON.parse(saved!.payload).kind).toBe(operation)
  expect(state.signPublic).not.toHaveBeenCalled()
  state.send.mockImplementation(server)
  await expect(preparePrepaid(session)).resolves.toHaveProperty('ledgerId', ledgerId)
  expect(publications()).toHaveLength(1)
})

it('identifies discovery timeout without reporting private identifiers', async () => {
  vi.useFakeTimers(); state.send.mockResolvedValue(undefined)
  const failure = expect(preparePrepaid(session)).rejects.toThrow('Prepaid service discovery response timed out')
  await vi.advanceTimersByTimeAsync(45_000); await failure
  expect(state.record).toBeUndefined()
})

it.each([['balance', true], ['balance', false], ['execute', true], ['execute', false]] as const)
('distinguishes %s timeout with relay acknowledgement %s without replaying', async (kind, delivered) => {
  const credit = await preparePrepaid(session)
  vi.useFakeTimers()
  let sends = 0
  state.send.mockImplementation(async packet => {
    const request = JSON.parse(packet.params.encryptedData[0])
    if (request.authorization && JSON.parse(request.authorization.payload).kind === kind) {
      sends++
      if (!delivered) await new Promise(() => {})
      return
    }
    await server(packet)
  })
  const failed = expect(kind === 'balance' ? assertPrepaidContext(session, credit.selected, gas, credit)
    : submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit))
    .rejects.toThrow(`Prepaid ${kind === 'balance' ? 'balance check' : 'transaction submission'} response timed out (${delivered ? 'relay accepted; reply missing' : 'relay acceptance unknown'})`)
  await vi.advanceTimersByTimeAsync(45_000); await failed
  expect(sends).toBe(1)
  expect(!!(state.record as { attempt?: unknown }).attempt).toBe(kind === 'execute')
  expect(state.signPublic).not.toHaveBeenCalled()
})

it.each([0, 1])('checks the encrypted wire-byte boundary before publication: %s bytes over', async over => {
  const encoded = { randomPubKey: '02'.repeat(32), encryptedData: ['', 'nonce'], sharedKey: new Uint8Array(32) }
  const overhead = toUtf8Bytes(JSON.stringify({ method: 'transact', id: `0x${'00'.repeat(32)}`,
    params: { pubkey: encoded.randomPubKey, encryptedData: encoded.encryptedData } })).length
  encoded.encryptedData[0] = 'a'.repeat(CREDIT_MAX_MESSAGE_BYTES - overhead + over)
  state.encrypt.mockResolvedValue(encoded)
  state.send.mockRejectedValue(new Error('Boundary packet reached transport'))
  await expect(preparePrepaid(session)).rejects.toThrow(over ? 'encrypted message size limit' : 'Boundary packet reached transport')
  expect(state.send).toHaveBeenCalledTimes(over ? 0 : 1)
  expect(state.record).toBeUndefined()
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('keeps an oversized execution recoverable without publishing it or automatically retrying', async () => {
  const credit = await preparePrepaid(session), normalEncrypt = state.encrypt.getMockImplementation()!
  state.encrypt.mockImplementation(async data => data.authorization?.payload.includes('"kind":"execute"')
    ? { randomPubKey: '02'.repeat(32), encryptedData: ['a'.repeat(CREDIT_MAX_MESSAGE_BYTES), 'nonce'], sharedKey: new Uint8Array(32) }
    : normalEncrypt(data))
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).rejects.toThrow('encrypted message size limit')
  const record = structuredClone(state.record) as { attempt: { key: string; payload: string } }
  expect(record.attempt.key).toBe(creditRequestKey(ledgerId, owner.address, record.attempt.payload))
  expect(JSON.parse(record.attempt.payload).kind).toBe('execute')
  expect(state.messages.every(message => !(message.authorization as { payload?: string })?.payload?.includes('"kind":"execute"'))).toBe(true)
  expect(state.signPublic).not.toHaveBeenCalled()
  state.encrypt.mockImplementation(normalEncrypt)
  await prepaidBalance(session)
  expect(state.record).toEqual(record)
})

it('rejects a server identity mismatch and an edited quote before disclosure', async () => {
  state.send.mockImplementationOnce(async (packet) => respond(packet, JSON.parse(packet.params.encryptedData[0]), {
    scope: { ...scope(), operator: publicOwner.address }, ledgerId, confirmation: 'finalized', funding: 'user-submitted-private-transfer' }))
  await expect(preparePrepaid(session)).rejects.toThrow('scope changed')
  const credit = await preparePrepaid(session)
  await expect(assertPrepaidContext(session, credit.selected, { ...gas, gasPrice: 600_000_000n }, credit)).rejects.toThrow('gas limits')
  await expect(assertPrepaidContext(session, { ...credit.selected, tokenFee: { ...credit.selected.tokenFee, feesID: 'cd'.repeat(32) } }, gas, credit)).rejects.toThrow('changed')
})

it('binds the delegated execution to the canonical authorization before journaling', async () => {
  const credit = await preparePrepaid(session)
  const authorization = await publicOwner.authorize({ chainId: 1, address: CONFIG.relayAdapt7702Contract, nonce: 0 })
  const type4 = { evmGasType: 4 as const, gasEstimate: 100_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }
  const fresh = { monotonic: performance.now(), wallTime: Date.now() }
  const wrong = { ...populated, transaction: { to: owner.address, data: '0xaabb', authorizationList: [authorization] } }
  await expect(submitPrepaid(session, wrong, credit.selected, type4, true, fresh, credit)).rejects.toThrow('authorization')
  expect((await pendingPrepaid(session))?.key).toBeUndefined()
  const correct = { ...wrong, transaction: { ...wrong.transaction, to: publicOwner.address } }
  expect(await submitPrepaid(session, correct, credit.selected, type4, true, fresh, credit)).toBe(hash)
  const consent = state.messages.at(-1)!.authorization as { payload: string }
  expect(JSON.parse(consent.payload).request.authorization.chainId).toBe('1')
})

it('rejects an authenticated balance that violates its accounting identity', async () => {
  await preparePrepaid(session)
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0])
    if (request.kind === 'info') return server(packet)
    const authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    respond(packet, request, { kind: 'balance', owner: owner.address, memo: creditMemo(scope(), ledgerId, owner.address),
      available: '1', deposited: '0', charged: '0', reserved: '0', refunds: '0' }, authorized.key)
  })
  await expect(prepaidBalance(session)).rejects.toThrow('inconsistent')
})

it('persists the exact execution consent before sending and reauthenticates unchanged bytes after an unknown outcome', async () => {
  vi.useFakeTimers()
  const credit = await preparePrepaid(session)
  state.send.mockImplementation(async (packet) => {
    const data = JSON.parse(packet.params.encryptedData[0])
    if (data.authorization?.payload.includes('"kind":"execute"')) state.messages.push(data)
    else await server(packet)
  })
  const attempt = submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)
  const failure = expect(attempt).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(45_000); await failure
  const first = state.messages.at(-1)!.authorization as { payload: string; expires: number }
  expect((state.record as { attempt: { payload: string } }).attempt.payload).toBe(first.payload)
  expect(JSON.parse(first.payload).maximumCharge).toBe(prepaidAttemptFee(credit, gas).toString())
  expect(JSON.parse(first.payload).sequence).toBe(credit.nextSequence)
  state.send.mockImplementation(server)
  expect(await retryPrepaid(session)).toBe(hash)
  const second = state.messages.at(-1)!.authorization as { payload: string; expires: number }
  expect(second.payload).toBe(first.payload)
  expect(second.expires).toBeGreaterThan(first.expires)
  expect(await pendingPrepaid(session)).toMatchObject({ hash, request: { to: proxy, data: '0xaabb' } })
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).rejects.toThrow('Reconcile')
})

it('rejects a final price check that ages while the prepaid request is encrypted', async () => {
  const credit = await preparePrepaid(session), clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
  const delegated = { ...populated, transaction: { to: publicOwner.address, data: '0xaabb', value: 0n,
    authorizationList: [await publicOwner.authorize({ chainId: 1, address: CONFIG.relayAdapt7702Contract, nonce: 0 })] } }
  state.encrypt.mockImplementation(async (data) => {
    if (data.authorization?.payload.includes('"kind":"execute"')) clock.mockReturnValue(31_000)
    return { encryptedData: [JSON.stringify(data), `0x${'01'.repeat(32)}`], randomPubKey: '02'.repeat(32), sharedKey: new Uint8Array(32).fill(1) }
  })
  try {
    await expect(submitPrepaid(session, delegated, credit.selected, { evmGasType: 4, gasEstimate: 100_000n,
      maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }, true, { monotonic: 1000, wallTime: Date.now() }, credit)).rejects.toThrow('Final price')
    expect((await pendingPrepaid(session))?.key).toBeTruthy()
    expect(state.messages.some((message) => (message.authorization as { payload: string } | undefined)?.payload.includes('execute'))).toBe(false)
  } finally { clock.mockRestore() }
})

it('retains unknown top-up proof and claims only its exact finalized canonical transaction', async () => {
  const credit = await preparePrepaid(session)
  state.signPublic.mockImplementationOnce(async () => { expect(state.record).toHaveProperty('topUp'); throw new Error('Wallet disconnected after sending') })
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('Wallet disconnected')
  expect(state.events.indexOf('saved')).toBeLessThan(state.events.indexOf('proved') + 2)
  expect((await pendingPrepaid(session))?.topUpPending).toBe(true)
  state.finalized = 98
  await expect(claimPrepaidTopUp(session)).rejects.toThrow('not finalized')
  state.finalized = 100; state.canonical = false
  await expect(claimPrepaidTopUp(session)).rejects.toThrow('differs')
  state.canonical = true
  vi.mocked(session.provider.getTransaction).mockResolvedValue({ from: owner.address, to: proxy, data: '0xaabb', value: 0n, chainId: 1n, nonce: 50 } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  expect((await claimPrepaidTopUp(session)).available).toBe(2_000_000_000_000_000n)
  expect((await pendingPrepaid(session))?.topUpPending).toBe(false)
})

it.each([1, 56])('keeps chain %s production approval usable after the former cutoff without accepting expired quotes', async (chainId) => {
  const { PREPAID_BROADCASTERS } = await vi.importActual<typeof import('./config')>('./config')
  state.policy.expiresAt = PREPAID_BROADCASTERS[chainId]!.expiresAt
  expect(state.policy.expiresAt).toBe(Number.POSITIVE_INFINITY)
  state.policy.funding = 'native'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2100-01-01T00:00:00Z'))
  const credit = await preparePrepaid(session)
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).resolves.toBe(hash)
  vi.setSystemTime(new Date(Date.now() + 300_000))
  await expect(assertPrepaidContext(session, credit.selected, gas, credit)).rejects.toThrow(/prepaid quote/)
})

it('permits read/recovery after approval expiry but forbids new execution and preserves unfinalized reservations', async () => {
  const credit = await preparePrepaid(session)
  await submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)
  state.policy.expiresAt = 0
  expect((await pendingPrepaid(session))?.hash).toBe(hash)
  expect((await prepaidBalance(session)).available).toBeGreaterThan(0n)
  await expect(preparePrepaid(session)).rejects.toThrow('not approved')
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    respond(packet, request, { kind: 'attempt', hash, cancellationHash: null, state: 'settled', charged: '100' }, authorized.key)
  })
  vi.mocked(session.provider.getTransaction).mockResolvedValue({ from: scope().operator, chainId: 1n } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  state.finalized = 98
  await expect(checkPrepaid(session)).rejects.toThrow('not finalized')
  expect((await pendingPrepaid(session))?.key).toBeTruthy()
  state.finalized = 100
  expect(await checkPrepaid(session)).toMatchObject({ hash, state: 'settled', charged: 100n, cancelled: false })
  expect(await pendingPrepaid(session)).toMatchObject({ key: expect.any(String), hash, completed: true })
  expect(await checkPrepaid(session)).toMatchObject({ hash, state: 'settled' })
  state.policy.expiresAt = Number.MAX_SAFE_INTEGER
  state.send.mockImplementation(server)
  await expect(assertPrepaidContext(session, credit.selected, gas, credit)).resolves.toBeUndefined()
})

it('rejects insufficient confirmed credit before storing or disclosing any private proof', async () => {
  const credit = await preparePrepaid(session)
  state.available = '0'
  await expect(assertPrepaidContext(session, credit.selected, gas, credit)).rejects.toThrow('insufficient')
  expect((await pendingPrepaid(session))?.key).toBeUndefined()
  expect(state.messages.some((message) => (message.authorization as { payload: string } | undefined)?.payload.includes('execute'))).toBe(false)
})

it('journals execution before publication without another balance query after proof disclosure', async () => {
  const credit = await preparePrepaid(session)
  await assertPrepaidContext(session, credit.selected, gas, credit)
  const afterPreflight = state.messages.length
  state.events = []
  state.send.mockImplementation(async packet => {
    const request = JSON.parse(packet.params.encryptedData[0])
    expect(JSON.parse(request.authorization.payload).kind).toBe('execute')
    expect(state.record).toHaveProperty('attempt.payload', request.authorization.payload)
    state.events.push('published')
    await server(packet)
  })
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).resolves.toBe(hash)
  expect(state.messages.length - afterPreflight).toBe(1)
  expect(state.events).toEqual(['saved', 'published', 'saved'])
})


it.each([undefined, 99_999n])('rejects a refund above its payable quote before saving an irreversible request: %s', async (maximumRefundGross) => {
  await preparePrepaid(session)
  const credit = await preparePrepaidRefund(session)
  credit.maximumRefundGross = maximumRefundGross
  const messages = state.messages.length
  await expect(requestPrepaidRefund(session, credit, 100_000n)).rejects.toThrow('current payable amount')
  expect(state.record).not.toHaveProperty('refund')
  expect(state.messages).toHaveLength(messages)
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('journals a refund with explicit net terms and retains it until authenticated owner-transfer completion', async () => {
  await preparePrepaid(session)
  state.policy.expiresAt = 0; state.executionEnabled = false
  await expect(preparePrepaid(session)).rejects.toThrow('not approved')
  const credit = await preparePrepaidRefund(session)
  let refundPayload = '', refundKey = '', paid = false
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    if (authorized.payload.kind === 'refund') { refundPayload = authorized.authorization.payload; refundKey = authorized.key }
    const payload = JSON.parse(refundPayload)
    expect(state.record).toHaveProperty('refund')
    respond(packet, request, { kind: 'refund', recipient: payload.recipient, gross: payload.gross, net: payload.net,
      memo: creditRefundMemo(scope(), ledgerId, refundKey), state: paid ? 'refunded' : 'awaiting-owner-transfer',
      transactionHash: paid ? hash : null }, authorized.key)
  })
  const refund = await requestPrepaidRefund(session, credit, 100_000n)
  expect(refund.net).toBe(100_000n - prepaidRefundFee(credit))
  expect(refund.state).toBe('awaiting-owner-transfer')
  expect((await pendingPrepaid(session))?.refundPending).toBe(true)
  paid = true
  expect((await checkPrepaidRefund(session)).state).toBe('refunded')
  expect((await pendingPrepaid(session))?.refundPending).toBe(false)
  expect(refund.key).toBe(creditRequestKey(ledgerId, owner.address, refundPayload))
  expect(JSON.parse(refundPayload).sequence).toBe(credit.nextSequence)
})

it('resumes a refund lost before admission with the exact saved terms and owner-bound key', async () => {
  await preparePrepaid(session)
  const credit = await preparePrepaidRefund(session)
  state.send.mockRejectedValueOnce(new Error('Transport failed before admission'))
  await expect(requestPrepaidRefund(session, credit, 100_000n)).rejects.toThrow('Transport failed')
  const original = structuredClone((state.record as { refund: { key: string; payload: string } }).refund)
  let repeats = 0
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    expect(authorized.authorization.payload).toBe(original.payload)
    expect(authorized.key).toBe(original.key)
    repeats++
    const terms = JSON.parse(original.payload)
    respond(packet, request, { kind: 'refund', recipient: terms.recipient, gross: terms.gross, net: terms.net,
      memo: creditRefundMemo(scope(), ledgerId, original.key), state: 'awaiting-owner-transfer', transactionHash: null }, authorized.key)
  })
  await expect(checkPrepaidRefund(session)).resolves.toMatchObject({ key: original.key, state: 'awaiting-owner-transfer' })
  await expect(checkPrepaidRefund(session)).resolves.toMatchObject({ key: original.key, state: 'awaiting-owner-transfer' })
  expect(repeats).toBe(2)
  expect((state.record as { refund: unknown }).refund).toEqual(original)
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('clears an expired never-reserved refund only after authenticated retirement of its exact key', async () => {
  await preparePrepaid(session)
  const credit = await preparePrepaidRefund(session)
  state.send.mockRejectedValueOnce(new Error('Dropped refund'))
  await expect(requestPrepaidRefund(session, credit, 100_000n)).rejects.toThrow('Dropped refund')
  const original = (state.record as { refund: { key: string; payload: string } }).refund
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    if (authorized.payload.kind === 'refund') throw new Error('Prepaid quote expired')
    expect(authorized.payload).toEqual({ kind: 'recover', operation: 'refund', sequence: 1, payloadHash: keccak256(toUtf8Bytes(original.payload)) })
    respond(packet, request, { kind: 'recovery', recoveredKey: original.key, operation: 'refund', sequence: 1, retiredThrough: 1, state: 'not-reserved' }, authorized.key)
  })
  await expect(checkPrepaidRefund(session)).resolves.toMatchObject({ key: original.key, state: 'not-reserved' })
  expect((await pendingPrepaid(session))?.refundPending).toBe(false)
  state.send.mockImplementation(server)
  await expect(preparePrepaidRefund(session)).resolves.toMatchObject({ ledgerId })
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('keeps a refund on generic rejection, unavailable recovery, or a mismatched retirement response', async () => {
  await preparePrepaid(session)
  const credit = await preparePrepaidRefund(session)
  state.send.mockRejectedValue(new Error('Offline'))
  await expect(requestPrepaidRefund(session, credit, 100_000n)).rejects.toThrow('Offline')
  const record = structuredClone(state.record)
  await expect(checkPrepaidRefund(session)).rejects.toThrow('Offline')
  expect(state.record).toEqual(record)
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    if (authorized.payload.kind === 'refund') throw new Error('Quote expired')
    respond(packet, request, { kind: 'recovery', recoveredKey: id('another request'), operation: 'refund', sequence: 1, retiredThrough: 1, state: 'not-reserved' }, authorized.key)
  })
  await expect(checkPrepaidRefund(session)).rejects.toThrow('Invalid prepaid recovery')
  expect(state.record).toEqual(record)
})

it('retires an unaccepted execution after quote expiry while preserving its proof and permitting credit refunds', async () => {
  const credit = await preparePrepaid(session)
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0])
    if (request.authorization && JSON.parse(request.authorization.payload).kind === 'execute') throw new Error('Dropped execution')
    return server(packet)
  })
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).rejects.toThrow('Dropped execution')
  const original = structuredClone((state.record as { attempt: { key: string; payload: string } }).attempt)
  const privateProof = { account: publicOwner.address, inputs: [id('private input')] }
  state.privateSwap = privateProof
  vi.useFakeTimers(); vi.setSystemTime(credit.expires + 1)
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    expect(authorized.payload).toEqual({ kind: 'recover', operation: 'execute', sequence: 1, payloadHash: keccak256(toUtf8Bytes(original.payload)) })
    respond(packet, request, { kind: 'recovery', recoveredKey: original.key, operation: 'execute', sequence: 1, retiredThrough: 1, state: 'not-reserved' }, authorized.key)
  })
  await expect(checkPrepaid(session)).resolves.toMatchObject({ state: 'not-reserved', charged: 0n, cancelled: false })
  expect(state.record).not.toHaveProperty('attempt')
  expect(state.record).toHaveProperty('completed.attempt.payload', original.payload)
  expect(state.privateSwap).toBe(privateProof)
  expect(await pendingPrepaid(session)).toMatchObject({ key: original.key, completed: true, state: 'not-reserved' })
  state.send.mockRejectedValue(new Error('No extra request on reload'))
  await expect(checkPrepaid(session)).resolves.toMatchObject({ state: 'not-reserved', charged: 0n })
  state.send.mockImplementation(server)
  const refundCredit = await preparePrepaidRefund(session)
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    const terms = authorized.payload
    respond(packet, request, { kind: 'refund', recipient: terms.recipient, gross: terms.gross, net: terms.net,
      memo: creditRefundMemo(scope(), ledgerId, authorized.key), state: 'awaiting-owner-transfer', transactionHash: null }, authorized.key)
  })
  await expect(requestPrepaidRefund(session, refundCredit, 100_000n)).resolves.toMatchObject({ state: 'awaiting-owner-transfer' })
  expect(state.record).toHaveProperty('completed.attempt.payload', original.payload)
  expect(state.privateSwap).toBe(privateProof)
  expect(state.signPublic).not.toHaveBeenCalled()
})

it.each([261_444, CREDIT_MAX_PAYLOAD])('recovers a saved %i-character execution using a bounded owner-signed hash', async (size) => {
  const credit = await preparePrepaid(session)
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0])
    if (request.authorization && JSON.parse(request.authorization.payload).kind === 'execute') throw new Error('Dropped execution')
    return server(packet)
  })
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).rejects.toThrow('Dropped execution')
  const record = state.record as { attempt: { key: string; payload: string } }
  const original = JSON.parse(record.attempt.payload)
  original.request.data += 'a'.repeat(size - record.attempt.payload.length)
  const payload = JSON.stringify(original), key = creditRequestKey(ledgerId, owner.address, payload)
  expect(payload.length).toBe(size)
  record.attempt = { payload, key }
  const sdk = await vi.importActual<typeof import('@railgun-community/wallet')>('@railgun-community/wallet')
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    expect(authorized.payload).toEqual({ kind: 'recover', operation: 'execute', sequence: 1, payloadHash: keccak256(toUtf8Bytes(payload)) })
    expect(authorized.authorization.payload.length).toBeLessThan(200)
    const encrypted = await sdk.encryptDataWithSharedKey(request, sdk.getRailgunWalletAddressData(scope().recipient).viewingPublicKey)
    const wire = JSON.stringify({ method: 'transact', id: packet.id,
      params: { pubkey: encrypted.randomPubKey, encryptedData: encrypted.encryptedData } })
    expect(toUtf8Bytes(wire).length).toBeLessThan(2_000)
    respond(packet, request, { kind: 'recovery', recoveredKey: key, operation: 'execute', sequence: 1, retiredThrough: 1, state: 'not-reserved' }, authorized.key)
  })
  await expect(checkPrepaid(session)).resolves.toMatchObject({ key, state: 'not-reserved', charged: 0n })
  expect(state.record).toHaveProperty('completed.attempt.payload', payload)
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('keeps an execution on recovery timeout or a retirement for another operation or key', async () => {
  const credit = await preparePrepaid(session)
  await submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)
  const record = structuredClone(state.record)
  vi.useFakeTimers()
  state.send.mockResolvedValue(undefined)
  const rejected = expect(checkPrepaid(session)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(45_000); await rejected
  expect(state.record).toEqual(record)
  for (const change of [{ recoveredKey: id('wrong request') }, { operation: 'refund' }, { sequence: null },
    { sequence: undefined }, { sequence: 2 }, { retiredThrough: 0 }, { retiredThrough: -1 },
    { retiredThrough: 1.5 }, { retiredThrough: Number.MAX_SAFE_INTEGER }, { retiredThrough: '1' }, {}]) {
    state.send.mockImplementation(async (packet) => {
      const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
      const key = (record as { attempt: { key: string } }).attempt.key
      respond(packet, request, { kind: 'recovery', recoveredKey: key, operation: 'execute', sequence: 1, retiredThrough: 1, state: 'not-reserved', ...change }, authorized.key)
    })
    await expect(checkPrepaid(session)).rejects.toThrow(Object.keys(change).length ? 'Invalid prepaid recovery' : 'lost an acknowledged attempt')
    expect(state.record).toEqual(record)
  }
})

it.each(['execute', 'refund'] as const)('recovers a legacy %s only with explicit disabled-legacy confirmation', async (operation) => {
  const prepared = await preparePrepaid(session)
  const credit = operation === 'refund' ? await preparePrepaidRefund(session) : prepared
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0])
    if (request.authorization && JSON.parse(request.authorization.payload).kind === operation) throw new Error('Dropped')
    return server(packet)
  })
  await expect(operation === 'execute'
    ? submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)
    : requestPrepaidRefund(session, credit, 100_000n)).rejects.toThrow('Dropped')
  const record = state.record as { attempt?: { key: string; payload: string }; refund?: { key: string; payload: string } }
  const original = (operation === 'execute' ? record.attempt : record.refund)!
  const terms = JSON.parse(original.payload)
  delete terms.sequence
  original.payload = JSON.stringify(terms)
  original.key = creditRequestKey(ledgerId, owner.address, original.payload)
  const preserved = structuredClone(state.record)
  let explicit = false
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    if (authorized.payload.kind === 'refund') throw new Error('Legacy admission disabled')
    expect(authorized.payload).toEqual({ kind: 'recover', operation, payloadHash: keccak256(toUtf8Bytes(original.payload)) })
    respond(packet, request, { kind: 'recovery', recoveredKey: original.key, operation, state: 'not-reserved',
      sequence: explicit ? null : undefined, retiredThrough: 0 }, authorized.key)
  })
  const recover = () => operation === 'execute' ? checkPrepaid(session) : checkPrepaidRefund(session)
  await expect(recover()).rejects.toThrow('Invalid prepaid recovery')
  expect(state.record).toEqual(preserved)
  explicit = true
  await expect(recover()).resolves.toMatchObject({ state: 'not-reserved' })
  if (operation === 'execute') expect(state.record).toHaveProperty('completed.attempt.payload', original.payload)
  else expect(state.record).not.toHaveProperty('refund')
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('blocks new funding when execution is paused while keeping pinned balance reads available', async () => {
  const credit = await preparePrepaid(session)
  state.executionEnabled = false
  await expect(preparePrepaid(session)).rejects.toThrow('paused')
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('Refresh')
  expect((await prepaidBalance(session)).available).toBeGreaterThan(0n)
  expect(state.signPublic).not.toHaveBeenCalled()
})

it('retries only the exact saved top-up with its fixed public nonce after an unknown outcome', async () => {
  const credit = await preparePrepaid(session)
  state.completedHash = undefined
  state.signPublic.mockRejectedValueOnce(new Error('Unknown wallet outcome'))
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('Unknown')
  const proof = structuredClone((state.record as { topUp: { transaction: unknown } }).topUp.transaction)
  state.policy.expiresAt = 0; state.executionEnabled = false
  state.publicPending = 1
  await expect(retryPrepaidTopUp(session, publicSigner, () => {})).rejects.toThrow('unknown pending')
  expect(state.signPublic).toHaveBeenCalledOnce()
  state.publicPending = 0
  expect(await retryPrepaidTopUp(session, publicSigner, () => {})).toBe(hash)
  expect(state.signPublic.mock.calls[1][0]).toMatchObject({ to: proxy, data: '0xaabb', value: 0n, nonce: 0, chainId: 1n })
  expect((state.record as { topUp: { transaction: unknown } }).topUp.transaction).toEqual(proof)
  expect(state.events.filter((event) => event === 'proved')).toHaveLength(1)
})

it('advances a saved top-up nonce only after its exact failed transaction is finalized and preserves the old attempt', async () => {
  const credit = await preparePrepaid(session)
  state.completedHash = undefined
  await topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)
  state.receiptStatus = 0; state.publicLatest = 1; state.publicPending = 1; state.finalized = 98
  await expect(retryPrepaidTopUp(session, publicSigner, () => {})).rejects.toThrow('finalized failed')
  expect(state.signPublic).toHaveBeenCalledOnce()
  state.finalized = 100
  state.publicPending = 0
  await expect(retryPrepaidTopUp(session, publicSigner, () => {})).rejects.toThrow('nonce is unknown')
  state.publicPending = 1
  const replacement = id('replacement')
  state.signPublic.mockResolvedValueOnce({ hash: replacement })
  expect(await retryPrepaidTopUp(session, publicSigner, () => {})).toBe(replacement)
  expect(state.signPublic.mock.calls[1][0]).toMatchObject({ data: '0xaabb', nonce: 1 })
  expect(state.record).toMatchObject({ topUp: { hash: replacement, nonce: 1, previous: [{ hash, nonce: 0 }] } })
  expect(state.events.filter((event) => event === 'proved')).toHaveLength(1)
})

it('reconciles a finalized earlier cancellation even when a later replacement hash never mined', async () => {
  const credit = await preparePrepaid(session)
  await submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)
  const earlier = id('earlier cancellation'), later = id('later cancellation')
  state.send.mockImplementation(async (packet) => {
    const request = JSON.parse(packet.params.encryptedData[0]), authorized = authenticateCreditRequest(scope(), ledgerId, request.authorization)
    respond(packet, request, { kind: 'attempt', hash, cancellationHash: later, settlementHash: earlier, state: 'settled', charged: '100' }, authorized.key)
  })
  vi.mocked(session.provider.getTransactionReceipt).mockImplementation(async (requested) => requested === earlier
    ? { status: 1, blockNumber: 99, blockHash, hash: earlier } as Awaited<ReturnType<typeof session.provider.getTransactionReceipt>> : null)
  vi.mocked(session.provider.getTransaction).mockResolvedValue({ from: scope().operator, chainId: 1n } as Awaited<ReturnType<typeof session.provider.getTransaction>>)
  expect(await checkPrepaid(session)).toMatchObject({ hash, cancellationHash: earlier, cancelled: true, state: 'settled' })
  expect((await pendingPrepaid(session))?.completed).toBe(true)
})


interface NativePaymentFixture {
  transaction: { to: string; data: string; value: string }; from: string; hash?: string; nonce: number;
  paymentId: string; nullifiers: string[]; previous?: { hash?: string; nonce: number }[]
}
const nativeRecord = () => state.record as { topUp?: NativePaymentFixture; deferredTopUps?: NativePaymentFixture[]; refund?: unknown }
const paymentTransaction = (payment: NativePaymentFixture, txHash: string) => ({ ...payment.transaction,
  value: BigInt(payment.transaction.value), from: payment.from, nonce: payment.nonce, type: 2, chainId: 1n, hash: txHash,
} as Awaited<ReturnType<typeof session.provider.getTransaction>>)
const paymentReceipt = (txHash: string) => ({ hash: txHash,status:1,blockNumber:99,blockHash,gasUsed:1000n,gasPrice:1n,
} as Awaited<ReturnType<typeof session.provider.getTransactionReceipt>>)

it('retains a same-nonce replacement history before the wallet prompt and credits the earlier payment when it mines',async()=>{
  state.policy.funding='native';const credit=await preparePrepaid(session)
  await topUpPrepaid(session,publicSigner,100_000n,()=>{},credit)
  const original=structuredClone(nativeRecord().topUp!),replacement=id('same nonce replacement')
  vi.mocked(session.provider.getTransactionReceipt).mockResolvedValue(null)
  vi.mocked(session.provider.getTransaction).mockResolvedValue(paymentTransaction(original,hash))
  state.signPublic.mockImplementationOnce(async()=>{
    expect(nativeRecord().topUp?.previous).toEqual([{hash,nonce:0}])
    return{hash:replacement}
  })
  expect(await retryPrepaidTopUp(session,publicSigner,()=>{})).toBe(replacement)
  expect(nativeRecord().topUp).toMatchObject({hash:replacement,nonce:0,previous:[{hash,nonce:0}]})
  vi.mocked(session.provider.getTransactionReceipt).mockImplementation(async candidate=>candidate===hash?paymentReceipt(hash):null)
  vi.mocked(session.provider.getTransaction).mockImplementation(async candidate=>paymentTransaction(original,candidate))
  await expect(claimPrepaidTopUp(session)).resolves.toHaveProperty('available')
  expect(JSON.parse((state.messages.at(-1)!.authorization as {payload:string}).payload).transactionHash).toBe(hash)
  expect((await pendingPrepaid(session))?.topUpPending).toBe(false)
})

it('accepts an exact pasted replacement payment even when another payment hash was already saved',async()=>{
  state.policy.funding='native';const credit=await preparePrepaid(session)
  await topUpPrepaid(session,publicSigner,100_000n,()=>{},credit)
  const payment=structuredClone(nativeRecord().topUp!),replacement=id('wallet replacement')
  vi.mocked(session.provider.getTransaction).mockResolvedValue(paymentTransaction(payment,replacement))
  await expect(claimPrepaidTopUp(session,replacement)).resolves.toHaveProperty('available')
  expect(JSON.parse((state.messages.at(-1)!.authorization as {payload:string}).payload).transactionHash).toBe(replacement)
})

it('explicitly defers a rejected prompt after unrelated nonce consumption and permits a refund without another payment',async()=>{
  state.policy.funding='native';const credit=await preparePrepaid(session)
  state.signPublic.mockRejectedValueOnce(new Error('Wallet prompt rejected'))
  await expect(topUpPrepaid(session,publicSigner,100_000n,()=>{},credit)).rejects.toThrow('rejected')
  const retained=structuredClone(nativeRecord().topUp!)
  state.publicLatest=1;state.publicPending=1
  await expect(retryPrepaidTopUp(session,publicSigner,()=>{})).rejects.toThrow('nonce was consumed')
  const publicCalls=state.signPublic.mock.calls.length
  expect(await deferPrepaidTopUp(session)).toBe(1)
  expect(nativeRecord().deferredTopUps).toEqual([retained]);expect(nativeRecord().topUp).toBeUndefined()
  expect(await pendingPrepaid(session)).toMatchObject({topUpPending:false,deferredTopUpCount:1})
  const refund=await preparePrepaidRefund(session)
  state.send.mockImplementation(async packet=>{
    const request=JSON.parse(packet.params.encryptedData[0]),auth=authenticateCreditRequest(scope(),ledgerId,request.authorization),payload=auth.payload
    respond(packet,request,{kind:'refund',recipient:payload.recipient,gross:payload.gross,net:payload.net,
      state:'submitted-or-unknown',nonce:10,transactionHash:id('refund after defer'),settlementHash:null,charged:null,netPaid:null},auth.key)
  })
  await expect(requestPrepaidRefund(session,refund,100_000n,publicOwner.address)).resolves.toHaveProperty('state','submitted-or-unknown')
  expect(nativeRecord().deferredTopUps).toEqual([retained]);expect(state.signPublic).toHaveBeenCalledTimes(publicCalls)
})

it('claims a late deferred payment without clearing a different active payment or another archived record',async()=>{
  state.policy.funding='native';let credit=await preparePrepaid(session)
  await topUpPrepaid(session,publicSigner,100_000n,()=>{},credit)
  const old=structuredClone(nativeRecord().topUp!)
  await deferPrepaidTopUp(session)
  credit=await preparePrepaid(session);state.signPublic.mockResolvedValueOnce({hash:id('second payment')})
  await topUpPrepaid(session,publicSigner,200_000n,()=>{},credit)
  const second=structuredClone(nativeRecord().topUp!);await deferPrepaidTopUp(session)
  credit=await preparePrepaid(session);state.signPublic.mockResolvedValueOnce({hash:id('active third payment')})
  await topUpPrepaid(session,publicSigner,300_000n,()=>{},credit)
  const active=structuredClone(nativeRecord().topUp!)
  vi.mocked(session.provider.getTransaction).mockResolvedValue(paymentTransaction(old,hash))
  await expect(claimPrepaidTopUp(session,hash)).resolves.toHaveProperty('available')
  expect(nativeRecord().topUp).toEqual(active);expect(nativeRecord().deferredTopUps).toEqual([second])
  expect((await pendingPrepaid(session))?.deferredTopUpCount).toBe(1)
})

it('requires a pasted hash for archived payments instead of automatically scanning all local history',async()=>{
  state.policy.funding='native';const credit=await preparePrepaid(session)
  await topUpPrepaid(session,publicSigner,100_000n,()=>{},credit);const old=structuredClone(nativeRecord().topUp!)
  await deferPrepaidTopUp(session)
  vi.mocked(session.provider.getTransaction).mockResolvedValue(paymentTransaction(old,hash))
  await expect(claimPrepaidTopUp(session)).rejects.toThrow('Paste its transaction hash')
  expect(session.provider.getTransaction).not.toHaveBeenCalled()
  await expect(claimPrepaidTopUp(session,hash)).resolves.toHaveProperty('available')
  expect((await pendingPrepaid(session))?.deferredTopUpCount).toBe(0)
  expect(state.signPublic).toHaveBeenCalledOnce()
})

it('retains the archived payment on canonical failure or a rejected/quarantined claim',async()=>{
  state.policy.funding='native';const credit=await preparePrepaid(session)
  await topUpPrepaid(session,publicSigner,100_000n,()=>{},credit);const old=structuredClone(nativeRecord().topUp!)
  await deferPrepaidTopUp(session)
  vi.mocked(session.provider.getTransaction).mockResolvedValue(paymentTransaction(old,hash))
  state.canonical=false
  await expect(claimPrepaidTopUp(session,hash)).rejects.toThrow('canonical history')
  expect(nativeRecord().deferredTopUps).toEqual([old])
  state.canonical=true;state.send.mockRejectedValueOnce(new Error('quarantined liability'))
  await expect(claimPrepaidTopUp(session,hash)).rejects.toThrow('quarantined')
  expect(nativeRecord().deferredTopUps).toEqual([old])
})

it.each(['payment-data','previous-hash','previous-nonce','duplicate-id','not-array'])('rejects damaged deferred payment data: %s',async damage=>{
  state.policy.funding='native';const credit=await preparePrepaid(session)
  await topUpPrepaid(session,publicSigner,100_000n,()=>{},credit);await deferPrepaidTopUp(session)
  const record=nativeRecord(),payment=record.deferredTopUps![0]
  if(damage==='payment-data')payment.transaction.data='0x'
  if(damage==='previous-hash')payment.previous=[{hash:'0x1234',nonce:0}]
  if(damage==='previous-nonce')payment.previous=[{hash,nonce:-1}]
  if(damage==='duplicate-id')record.deferredTopUps!.push(structuredClone(payment))
  if(damage==='not-array')record.deferredTopUps={} as never
  await expect(pendingPrepaid(session)).rejects.toThrow(/damaged|Duplicate/)
})

it('repeated explicit deferrals do not create a lifetime funding cap or silently delete uncertain records',async()=>{
  state.policy.funding='native'
  for(let i=0;i<17;i++){
    const credit=await preparePrepaid(session);state.signPublic.mockRejectedValueOnce(new Error('user rejected'))
    await expect(topUpPrepaid(session,publicSigner,100_000n,()=>{},credit)).rejects.toThrow('user rejected')
    expect(await deferPrepaidTopUp(session)).toBe(i+1)
  }
  const prior=structuredClone(nativeRecord().deferredTopUps),credit=await preparePrepaid(session)
  await expect(topUpPrepaid(session,publicSigner,100_000n,()=>{},credit)).resolves.toBe(hash)
  expect(nativeRecord().deferredTopUps).toEqual(prior);expect(nativeRecord().topUp?.hash).toBe(hash)
  expect(state.signPublic).toHaveBeenCalledTimes(18)
})

it('never defers a private proof as if it were a native public payment',async()=>{
  const credit=await preparePrepaid(session);await topUpPrepaid(session,publicSigner,100_000n,()=>{},credit)
  await expect(deferPrepaidTopUp(session)).rejects.toThrow('No active native')
  expect((await pendingPrepaid(session))?.topUpPending).toBe(true)
})

it('storage failure prevents a payment prompt and leaves active payment evidence intact if deferral cannot persist',async()=>{
  state.policy.funding='native';const credit=await preparePrepaid(session)
  const identity=structuredClone(state.record);state.writeError=true
  await expect(topUpPrepaid(session,publicSigner,100_000n,()=>{},credit)).rejects.toThrow('storage quota')
  expect(state.signPublic).not.toHaveBeenCalled();expect(state.record).toEqual(identity)
  state.writeError=false;await topUpPrepaid(session,publicSigner,100_000n,()=>{},credit)
  const retained=structuredClone(state.record);state.writeError=true
  await expect(deferPrepaidTopUp(session)).rejects.toThrow('storage quota')
  expect(state.record).toEqual(retained);expect(state.signPublic).toHaveBeenCalledOnce()
})
