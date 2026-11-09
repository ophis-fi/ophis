import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getAddress, hexlify, id, keccak256, toUtf8Bytes, Wallet, ZeroAddress, type JsonRpcSigner } from 'ethers'
import { CREDIT_MAX_PAYLOAD, CREDIT_PROTOCOL, authenticateCreditRequest, creditMemo, creditRefundMemo, creditRequestKey } from '../credit-protocol'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({
  writeError: false, record: undefined as unknown, recordKey: undefined as string | undefined, records: new Map<string, unknown>(), events: [] as string[], messages: [] as Record<string, unknown>[],
  privateSwap: undefined as unknown, privateWithdrawal: undefined as unknown,
  callback: undefined as ((value: unknown) => void) | undefined, core: {},
  send: vi.fn(), encrypt: vi.fn(), signPublic: vi.fn(), finalized: 100, canonical: true, available: '2000000000000000',
  nextSequence: 1, executionEnabled: true, completedHash: undefined as string | undefined, publicLatest: 0, publicPending: 0, receiptStatus: 1,
  policy: { operator: '0x001486E70A0c9291f5F55c68914eE0e4E4A604d4', railgunAddress: '',
    expiresAt: Number.MAX_SAFE_INTEGER, maxGasPrice: 500_000_000n, maxTransactionCost: 1_500_000_000_000_000n, funding: undefined as 'native' | undefined },
}))
vi.mock('./config', async (original) => {
  const config = await original<typeof import('./config')>()
  state.policy.railgunAddress = config.OPHIS_BROADCASTER
  return { ...config, CHAIN_ID: 1, CHAIN: 1n, PREPAID_BROADCASTERS: { 1: state.policy } }
})
vi.mock('./broadcaster', () => ({ startBroadcasters: vi.fn() }))
vi.mock('./storage', () => ({ readPrivateState: async (_session: unknown, key: string) => structuredClone(state.recordKey === undefined || state.recordKey === key ? state.record : state.records.get(key)),
  writePrivateState: async (_session: unknown, _key: string, value: unknown) => {
    if (state.writeError) throw new Error('Local storage quota exceeded')
    state.events.push('saved'); state.recordKey = _key; state.record = structuredClone(value); state.records.set(_key, structuredClone(value))
  } }))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn(), refreshReceivedBalances: vi.fn() }))
vi.mock('./shield', () => ({ assertPublicNetwork: vi.fn() }))
vi.mock('./journal', () => ({ pendingSwap: async () => state.privateSwap }))
vi.mock('./withdrawal-journal', () => ({ pendingWithdrawal: async () => state.privateWithdrawal }))
vi.mock('@railgun-community/waku-broadcaster-client-web', () => ({ WakuBroadcasterClient: {
  getWakuCore: () => state.core,
  addTransportSubscription: async (_core: unknown, _topic: string, callback: (value: unknown) => void) => { state.callback = callback },
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
import { CONFIG } from './config'
import { assertPrepaidContext, checkPrepaid, checkPrepaidRefund, claimPrepaidTopUp, pendingPrepaid, preparePrepaid, preparePrepaidRefund,
  deferPrepaidTopUp, prepaidAttemptFee, prepaidBalance, prepaidRefundFee, requestPrepaidRefund, retryPrepaid, submitPrepaid, topUpPrepaid } from './prepaid'
import { retryPrepaidTopUp } from './prepaid'

const owner = new Wallet(`0x${'11'.repeat(32)}`), publicOwner = new Wallet(`0x${'22'.repeat(32)}`)
const ledgerId = id('credit-ledger'), hash = id('transaction'), blockHash = id('block')
const proxy = getAddress(CONFIG.proxyContract)
const scope = () => ({ chainId: 1, operator: state.policy.operator,
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
  state.callback?.({ payload: toUtf8Bytes(JSON.stringify({ id: packet.id, result: [JSON.stringify(response), packet.params.encryptedData[1]] })) })
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
  state.writeError = false; state.record = undefined; state.recordKey = undefined; state.records.clear(); state.events = []; state.messages = []; state.core = {}; state.finalized = 100; state.canonical = true
  state.privateSwap = undefined; state.privateWithdrawal = undefined
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

it.each(['payer', 'operator'])('rejects delegated %s before asking for a native payment', async (role) => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  vi.mocked(role === 'payer' ? publicSigner.provider.getCode : session.provider.getCode).mockResolvedValue('0xef0100')
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('without smart-account delegation')
  expect(state.signPublic).not.toHaveBeenCalled()
  expect(state.record).not.toHaveProperty('topUp')
})

it('recovers a lost native payment hash only for the saved sender and exact payment', async () => {
  state.policy.funding = 'native'
  const credit = await preparePrepaid(session)
  state.signPublic.mockRejectedValueOnce(new Error('Wallet result lost'))
  await expect(topUpPrepaid(session, publicSigner, 100_000n, () => {}, credit)).rejects.toThrow('lost')
  const saved = (state.record as { topUp: { transaction: { to: string; data: string; value: string }; nonce: number } }).topUp
  const tx = { ...saved.transaction, value: 100_000n, from: publicOwner.address, chainId: 1n, nonce: saved.nonce, hash, type: 2 }
  for (const change of [{ value: 99_999n }, { from: owner.address }, { data: '0x' }, { chainId: 56n }]) {
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
  await expect(submitPrepaid(session, populated, credit.selected, gas, false, undefined, credit)).rejects.toThrow('insufficient')
  expect((await pendingPrepaid(session))?.key).toBeUndefined()
  expect(state.messages.some((message) => (message.authorization as { payload: string } | undefined)?.payload.includes('execute'))).toBe(false)
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
