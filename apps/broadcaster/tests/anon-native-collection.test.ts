import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getAddress, id, toBeHex, Wallet, ZeroAddress, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { ANON_COLLECTION_ABI, ANON_COLLECTION_GATEWAY, ANON_COLLECTION_HELPER, assertExternalOwnerTransaction,
  nativeCollectionEvidence, readAnonCollectionBaseFee, verifyAnonNativeCollection } from '../src/anon-native-collection'
import { finalizedCreditReceipt } from '../src/credit-payment'
import { CHAIN, NETWORK, TOKENS } from '../src/config'
import { PROXY } from '../src/transaction'

const runtime = readFileSync(new URL('./fixtures/anon-gateway-runtime.hex', import.meta.url), 'utf8').trim()
const helperRuntime = readFileSync(new URL('./fixtures/anon-gateway-helper-runtime.hex', import.meta.url), 'utf8').trim()
const operator = getAddress('0x0000000000000000000000000000000000000011')
const relayer = getAddress('0x0000000000000000000000000000000000000022')
const ephemeral = getAddress('0x0000000000000000000000000000000000000033')
function setup() {
  const hash = id('owner collection'), blockHash = id('owner collection block'), nullifiers = [id('owned input')]
  const transaction = {
    proof: { a: { x: 0n, y: 0n }, b: { x: [0n, 0n], y: [0n, 0n] }, c: { x: 0n, y: 0n } },
    merkleRoot: id('root'), nullifiers, commitments: [id('change'), id('unshield')],
    boundParams: { treeNumber: 2, minGasPrice: 0n, unshield: 1, chainID: CHAIN, adaptContract: ANON_COLLECTION_GATEWAY,
      adaptParams: id('adapt'), commitmentCiphertext: [] },
    unshieldPreimage: { npk: toBeHex(BigInt(ANON_COLLECTION_GATEWAY), 32), token: { tokenType: 0, tokenAddress: TOKENS[0].address, tokenSubID: 0 }, value: 1000n },
  }
  const data = { recipient: operator, integratorFeeBP: 0, integratorFeeRecipient: ZeroAddress,
    unwrapNative: true, unwrapERC1155: false, erc1155RecipientData: '0x' }
  const encodedGateway = () => ANON_COLLECTION_ABI.encodeFunctionData('unshield', [[transaction], data])
  const helper: any = { type: 'DELEGATECALL', from: ANON_COLLECTION_GATEWAY, to: ANON_COLLECTION_HELPER,
    input: '0x2898bb17' + encodedGateway().slice(10), value: '0x0', calls: [
    { type: 'CALL', from: ANON_COLLECTION_GATEWAY, to: NETWORK.proxyContract,
      input: PROXY.encodeFunctionData('transact', [[transaction]]), value: '0x0' },
  ] }
  const gateway: any = { type: 'CALL', from: ephemeral, to: ANON_COLLECTION_GATEWAY, input: encodedGateway(), value: '0x0', calls: [helper,
    { type: 'CALL', from: ANON_COLLECTION_GATEWAY, to: operator, input: '0x', value: '0x3e2' },
  ] }
  const trace: any = { type: 'CALL', from: relayer, to: ephemeral, input: '0x1234', value: '0x0', calls: [gateway] }
  const tx: any = { hash, blockHash, blockNumber: 10, chainId: CHAIN, from: relayer, to: ephemeral, data: trace.input,
    value: 0n, type: 2, authorizationList: null }
  const log = (name: string, args: unknown[], index: number) => ({ ...PROXY.encodeEventLog(PROXY.getEvent(name)!, args),
    address: NETWORK.proxyContract, transactionHash: hash, blockHash, blockNumber: 10, removed: false, index })
  const receipt = { hash, blockHash, blockNumber: 10, from: relayer, to: ephemeral, status: 1, gasUsed: 100n, gasPrice: 2n,
    logs: [log('Nullified', [2, nullifiers], 0), log('Unshield', [ANON_COLLECTION_GATEWAY, transaction.unshieldPreimage.token, 995n, 5n], 1)],
  } as unknown as TransactionReceipt
  const state = { code: runtime, helperCode: helperRuntime, canonicalHash: blockHash, trace, tx, receipt, traceError: false, afterTraceReorg: false,
    afterTraceLogsChanged: false, historicFee: 13n, currentFee: 13n }
  const provider = {
    getNetwork: async () => ({ chainId: CHAIN }),
    getBlock: async (tag: string | number) => ({ number: tag === 'finalized' ? 10 : tag, hash: state.canonicalHash, timestamp: 1234567890 }),
    getTransactionReceipt: async () => state.receipt,
    getTransaction: async () => state.tx,
    getCode: async (address: string) => address === ANON_COLLECTION_HELPER ? state.helperCode : state.code,
    call: async (request: any) => {
      expect(request.to).toBe(ANON_COLLECTION_GATEWAY)
      expect(request.data).toBe(ANON_COLLECTION_ABI.encodeFunctionData('baseFeeBP'))
      return ANON_COLLECTION_ABI.encodeFunctionResult('baseFeeBP', [request.blockTag === 10 ? state.historicFee : state.currentFee])
    },
    send: async (method: string, args: unknown[]) => {
      expect(method).toBe('debug_traceTransaction'); expect(args[0]).toBe(hash)
      if (state.traceError) throw new Error('unsupported trace')
      if (state.afterTraceReorg) state.canonicalHash = id('reorg')
      if (state.afterTraceLogsChanged) (state.receipt.logs as any[])[1] = log('Unshield', [ANON_COLLECTION_GATEWAY, transaction.unshieldPreimage.token, 994n, 6n], 1)
      return state.trace
    },
  } as unknown as JsonRpcProvider
  const expected = { operator, token: TOKENS[0].address, nullifiers, maximumInputs: 2, maximumOutputs: 2, maximumProofs: 1, minimumNative: 900n }
  const run = async () => verifyAnonNativeCollection(provider, await finalizedCreditReceipt(provider, hash), expected)
  const refreshCalldata = () => {
    gateway.input = encodedGateway(); helper.input = '0x2898bb17' + gateway.input.slice(10)
    helper.calls[0].input = PROXY.encodeFunctionData('transact', [[transaction]])
  }
  return { hash, state, provider, expected, run, gateway, helper, transaction, data, trace, receipt, refreshCalldata, log }
}

describe('ANON native collection canonical payout proof', () => {
  it('quotes only the pinned gateway current base fee and rejects fee or runtime drift', async () => {
    const e = setup()
    await expect(readAnonCollectionBaseFee(e.provider)).resolves.toBe(13n)
    e.state.currentFee = 14n
    await expect(readAnonCollectionBaseFee(e.provider)).rejects.toThrow('base fee')
    e.state.currentFee = 13n; e.state.code = '0x00'
    await expect(readAnonCollectionBaseFee(e.provider)).rejects.toThrow('runtime')
  })
  it('brands only exact finalized owned-input collection and native delivery under the pinned gateway', async () => {
    const e = setup(), proof = await e.run()
    expect(nativeCollectionEvidence(proof)).toMatchObject({ transactionHash: e.hash, grossUnshield: 1000n,
      nativeReceived: 994n, recipient: operator, token: TOKENS[0].address })
    expect(Object.isFrozen(nativeCollectionEvidence(proof))).toBe(true)
    expect(() => nativeCollectionEvidence({ verifiedNativeCollection: true })).toThrow('Verified canonical')
  })
  it.each(['gateway', 'helper', 'ancestor', 'payment', 'pool'])('rejects failure at the %s despite outer status1', async (place) => {
    const e = setup()
    if (place === 'gateway') e.gateway.error = 'execution reverted'
    if (place === 'helper') e.helper.error = 'execution reverted'
    if (place === 'ancestor') e.trace.error = 'execution reverted'
    if (place === 'payment') e.gateway.calls[1].error = 'execution reverted'
    if (place === 'pool') e.helper.calls[0].error = 'execution reverted'
    await expect(e.run()).rejects.toThrow()
  })
  it('rejects an intermediate failed ancestor even when the recorded inner native CALL succeeded', async () => {
    const e = setup()
    e.trace.calls = [{ type: 'CALL', from: ephemeral, to: relayer, input: '0x', value: '0x0', error: 'reverted', calls: [e.gateway] }]
    await expect(e.run()).rejects.toThrow('successful')
  })
  it.each(['from', 'to', 'input', 'value'])('rejects replayed trace with wrong root %s', async (field) => {
    const e = setup(); e.trace[field] = field === 'input' ? '0xabcd' : field === 'value' ? '0x1' : operator
    await expect(e.run()).rejects.toThrow('bound')
  })
  it.each(['wrong-recipient', 'no-unwrap', 'integrator-fee', 'extra-data'])('rejects unsupported gateway calldata: %s', async (kind) => {
    const e = setup()
    if (kind === 'wrong-recipient') e.data.recipient = relayer
    if (kind === 'no-unwrap') e.data.unwrapNative = false
    if (kind === 'integrator-fee') e.data.integratorFeeBP = 1
    if (kind === 'extra-data') e.data.erc1155RecipientData = '0x12'
    e.refreshCalldata(); await expect(e.run()).rejects.toThrow('recipient')
  })
  it.each(['fake-gateway', 'changed-code', 'delegate-payment', 'multiple-payments', 'wrong-value', 'outgoing-value', 'gateway-delegation'])('rejects %s', async (kind) => {
    const e = setup()
    if (kind === 'fake-gateway') e.gateway.to = relayer
    if (kind === 'changed-code') e.state.code = runtime.slice(0, -2) + '00'
    if (kind === 'delegate-payment') e.gateway.calls[1].type = 'DELEGATECALL'
    if (kind === 'multiple-payments') e.gateway.calls.push({ ...e.gateway.calls[1] })
    if (kind === 'wrong-value') e.gateway.calls[1].value = '0x3e4'
    if (kind === 'outgoing-value') e.gateway.calls[1].calls = [{ type: 'CALL', from: operator, to: relayer, input: '0x', value: '0x1' }]
    if (kind === 'gateway-delegation') e.gateway.calls.push({ type: 'DELEGATECALL', from: ANON_COLLECTION_GATEWAY, to: relayer, input: '0x', value: '0x0' })
    await expect(e.run()).rejects.toThrow()
  })
  it.each(['wrong-target', 'changed-runtime', 'wrong-selector', 'wrong-arguments', 'callcode', 'missing-helper'])('rejects unpinned helper execution: %s', async (kind) => {
    const e = setup()
    if (kind === 'wrong-target') e.helper.to = relayer
    if (kind === 'changed-runtime') e.state.helperCode = '0x00'
    if (kind === 'wrong-selector') e.helper.input = '0x00000000' + e.helper.input.slice(10)
    if (kind === 'wrong-arguments') e.helper.input += '00'
    if (kind === 'callcode') e.helper.type = 'CALLCODE'
    if (kind === 'missing-helper') e.gateway.calls[0] = e.helper.calls[0]
    await expect(e.run()).rejects.toThrow()
  })
  it.each(['CREATE', 'CREATE2'])('rejects native value forwarded through operator %s', async (type) => {
    const e = setup()
    e.gateway.calls[1].calls = [{ type, from: operator, to: relayer, input: '0x6000', value: '0x1' }]
    await expect(e.run()).rejects.toThrow('remain with')
  })
  it.each(['unknown-input', 'extra-nullifier-event', 'wrong-unshield', 'duplicate-unshield', 'too-many-outputs', 'zero-output-cap', 'zero-proof-cap'])('rejects unaccounted or unmeasured proof shape: %s', async (kind) => {
    const e = setup()
    if (kind === 'unknown-input') e.expected.nullifiers = [id('unaccounted')]
    if (kind === 'extra-nullifier-event') (e.receipt.logs as any[]).push(e.log('Nullified', [2, [id('extra')]], 2))
    if (kind === 'wrong-unshield') (e.receipt.logs as any[])[1] = e.log('Unshield', [operator, e.transaction.unshieldPreimage.token, 995n, 5n], 1)
    if (kind === 'duplicate-unshield') (e.receipt.logs as any[]).push({ ...e.receipt.logs[1], index: 2 })
    if (kind === 'too-many-outputs') { e.transaction.commitments.push(id('extra output')); e.refreshCalldata() }
    if (kind === 'zero-output-cap') e.expected.maximumOutputs = 0
    if (kind === 'zero-proof-cap') e.expected.maximumProofs = 0
    await expect(e.run()).rejects.toThrow()
  })
  it('rejects operator-paid transactions and operator authorization nonce consumption', async () => {
    const e = setup(); e.state.tx.from = operator
    await expect(e.run()).rejects.toThrow('external')
    const owner = Wallet.createRandom(); e.state.tx.from = relayer; e.expected.operator = owner.address
    e.state.tx.type = 4
    e.state.tx.authorizationList = [await owner.authorize({ address: ephemeral, nonce: 0, chainId: CHAIN })]
    await expect(assertExternalOwnerTransaction(e.provider, await finalizedCreditReceipt(e.provider, e.hash), owner.address)).rejects.toThrow('nonce')
  })
  it('allows an independently authorized ephemeral account without touching the operator nonce', async () => {
    const e = setup(), owner = Wallet.createRandom()
    e.state.tx.type = 4; e.state.tx.authorizationList = [await owner.authorize({ address: ephemeral, nonce: 0, chainId: CHAIN })]
    expect(nativeCollectionEvidence(await e.run()).nativeReceived).toBe(994n)
  })
  it('rejects mismatched transaction and receipt participants', async () => {
    const e = setup(); e.state.tx.from = ephemeral
    await expect(e.run()).rejects.toThrow('external')
  })
  it.each(['unsupported-trace', 'reorg', 'empty-trace', 'wide-trace', 'unknown-field'])('fails closed on %s', async (kind) => {
    const e = setup()
    if (kind === 'unsupported-trace') e.state.traceError = true
    if (kind === 'reorg') e.state.afterTraceReorg = true
    if (kind === 'empty-trace') e.state.trace = {}
    if (kind === 'wide-trace') e.trace.calls = Array(1025).fill(e.gateway)
    if (kind === 'unknown-field') e.trace.arbitraryNestedObject = { input: 'unbounded' }
    await expect(e.run()).rejects.toThrow()
  })
  it('requires the owner-intent economic minimum rather than any positive transfer', async () => {
    const e = setup(); e.expected.minimumNative = 995n
    await expect(e.run()).rejects.toThrow('exact native')
  })
  it.each(['historicFee', 'currentFee'] as const)('rejects a changed gateway %s', async (field) => {
    const e = setup(); e.state[field] = 14n
    await expect(e.run()).rejects.toThrow('base fee')
  })
  it('rejects the pool net amount when it omits the separate pinned gateway fee', async () => {
    const e = setup(); e.gateway.calls[1].value = '0x3e3'
    await expect(e.run()).rejects.toThrow('exact native')
  })
  it('rejects receipt log changes during tracing even when an RPC object is reused', async () => {
    const e = setup(); e.state.afterTraceLogsChanged = true
    await expect(e.run()).rejects.toThrow()
  })
  it('requires receipt verification provenance before inspecting any trace', async () => {
    const e = setup()
    await expect(verifyAnonNativeCollection(e.provider, e.receipt, e.expected)).rejects.toThrow('verified finalized')
  })
})
