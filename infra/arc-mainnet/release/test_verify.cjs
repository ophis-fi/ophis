// Offline canonical-block fallback regressions. No RPC, keys or release-file writes.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { dep } = require('./plan.cjs')
const { Formatter } = dep('@ethersproject/providers')
const { deploymentTransaction } = require('./verify.cjs')
const HASH = '0x' + '11'.repeat(32), OTHER = '0x' + '22'.repeat(32), BLOCK = '0x' + '33'.repeat(32)
const FROM = '0x' + '11'.repeat(20), CONTRACT = '0x' + '22'.repeat(20)

function fixture(indexedReceipt = false, indexedTx = false) {
  const formatter = new Formatter()
  const tx = { hash: HASH, blockHash: BLOCK, blockNumber: '0x64', transactionIndex: '0x1',
    from: FROM, to: null, nonce: '0x7', gas: '0x100000', gasPrice: '0x1', value: '0x0', input: '0x6000',
    type: '0x0', chainId: '0x13b2', v: '0x2787', r: HASH, s: OTHER }
  const receipt = { transactionHash: HASH, blockHash: BLOCK, blockNumber: '0x64', transactionIndex: '0x1',
    from: FROM, to: null, contractAddress: CONTRACT, status: '0x1', gasUsed: '0x5208',
    cumulativeGasUsed: '0xa410', logs: [], logsBloom: '0x' + '00'.repeat(256), type: '0x0' }
  const block = { number: '0x64', hash: BLOCK, transactions: [{ ...tx, hash: OTHER, transactionIndex: '0x0' }, tx] }
  const state = { tx, receipt, block, blockReceipts: [{ ...receipt, transactionHash: OTHER, transactionIndex: '0x0' }, receipt],
    current: { number: '0x64', hash: BLOCK }, head: 101,
    indexedReceipt: indexedReceipt ? formatter.receipt({ ...receipt, confirmations: 2 }) : null,
    indexedTx: indexedTx ? formatter.transactionResponse({ ...tx }) : null }
  const calls = []
  const rpc = { formatter,
    async getTransactionReceipt(hash) { assert.equal(hash, HASH); calls.push('receipt'); return state.indexedReceipt },
    async getTransaction(hash) { assert.equal(hash, HASH); calls.push('transaction'); return state.indexedTx },
    async getBlockNumber() { calls.push('head'); return state.head },
    async send(method, params) {
      calls.push(method)
      if (method === 'eth_getBlockByNumber') {
        assert.deepEqual(params, ['0x64', params[1]])
        assert.equal(typeof params[1], 'boolean')
        return params[1] ? state.block : state.current
      }
      assert.equal(method, 'eth_getBlockReceipts'); assert.deepEqual(params, ['0x64'])
      return state.blockReceipts
    } }
  // Deliberately false archived status/address/hash: only hash and number may be used.
  const recorded = { transactionHash: HASH, blockNumber: 100, blockHash: OTHER, status: 0, contractAddress: FROM }
  return { rpc, recorded, state, calls }
}

test('existing indexed lookup stays on its original path and ignores an unused block hint', async () => {
  const f = fixture(true, true); f.recorded.blockNumber = -1
  const result = await deploymentTransaction(f.rpc, f.recorded)
  assert.equal(result.receipt, f.state.indexedReceipt); assert.equal(result.actual, f.state.indexedTx)
  assert.deepEqual(f.calls, ['receipt', 'transaction'])
})

for (const [receipt, tx] of [[false, false], [true, false], [false, true]]) {
  test(`canonical fallback when indexed receipt=${receipt}, transaction=${tx}`, async () => {
    const f = fixture(receipt, tx)
    const result = await deploymentTransaction(f.rpc, f.recorded)
    assert.equal(result.receipt.contractAddress, CONTRACT); assert.equal(result.receipt.status, 1)
    assert.equal(result.receipt.confirmations, 2); assert.equal(result.actual.data, '0x6000')
    assert.equal(result.actual.nonce, 7); assert.equal(result.actual.value.toString(), '0')
    assert.equal(result.actual.from, FROM); assert.equal(result.actual.to, null)
    assert.equal(result.receipt.blockNumber, 100); assert.equal(result.actual.transactionIndex, 1)
    assert.deepEqual(f.calls, ['receipt', 'transaction', 'head', 'eth_getBlockByNumber', 'eth_getBlockReceipts', 'eth_getBlockByNumber'])
  })
}

test('accepts the raw JSON-RPC hex block number saved by the production deployer', async () => {
  const f = fixture(); f.recorded.blockNumber = '0x64'
  const result = await deploymentTransaction(f.rpc, f.recorded)
  assert.equal(result.receipt.blockNumber, 100)
  assert.equal(result.receipt.confirmations, 2)
})

const invalid = [
  ['missing hint', f => { delete f.recorded.blockNumber }],
  ['negative hint', f => { f.recorded.blockNumber = -1 }],
  ['fractional hint', f => { f.recorded.blockNumber = 100.5 }],
  ['string hint', f => { f.recorded.blockNumber = '100' }],
  ['noncanonical hex hint', f => { f.recorded.blockNumber = '0x064' }],
  ['invalid hex hint', f => { f.recorded.blockNumber = '0xGG' }],
  ['unsafe hex hint', f => { f.recorded.blockNumber = '0x20000000000000' }],
  ['unsafe hint', f => { f.recorded.blockNumber = Number.MAX_SAFE_INTEGER + 1 }],
  ['future block', f => { f.state.head = 99 }],
  ['invalid head', f => { f.state.head = NaN }],
  ['missing block', f => { f.state.block = null }],
  ['wrong block number', f => { f.state.block.number = '0x65' }],
  ['malformed block hash', f => { f.state.block.hash = '0x1234' }],
  ['missing transactions', f => { f.state.block.transactions = null }],
  ['absent transaction', f => { f.state.block.transactions = [] }],
  ['duplicate transaction', f => { f.state.block.transactions.push({ ...f.state.tx }) }],
  ['wrong transaction hash', f => { f.state.tx.hash = OTHER }],
  ['wrong transaction block', f => { f.state.tx.blockHash = OTHER }],
  ['wrong transaction height', f => { f.state.tx.blockNumber = '0x65' }],
  ['wrong inclusion index', f => { f.state.tx.transactionIndex = '0x0' }],
  ['missing receipts', f => { f.state.blockReceipts = null }],
  ['absent receipt', f => { f.state.blockReceipts = [] }],
  ['duplicate receipt', f => { f.state.blockReceipts.push({ ...f.state.receipt }) }],
  ['wrong receipt hash', f => { f.state.receipt.transactionHash = OTHER }],
  ['wrong receipt block', f => { f.state.receipt.blockHash = OTHER }],
  ['wrong receipt height', f => { f.state.receipt.blockNumber = '0x65' }],
  ['wrong receipt index', f => { f.state.receipt.transactionIndex = '0x0' }],
  ['reverted transaction', f => { f.state.receipt.status = '0x0' }],
  ['absent status', f => { delete f.state.receipt.status }],
  ['reorg during lookup', f => { f.state.current.hash = OTHER }],
  ['changed canonical height', f => { f.state.current.number = '0x65' }],
  ['canonical block disappeared', f => { f.state.current = null }],
]
for (const [name, change] of invalid) test(`rejects ${name}`, async () => {
  const f = fixture(); change(f)
  await assert.rejects(deploymentTransaction(f.rpc, f.recorded))
})

for (const indexed of [true, false]) {
  for (const field of ['blockHash', 'blockNumber', 'transactionIndex', 'transactionHash', 'status']) {
    test(`rejects inconsistent indexed receipt ${field}, fallback=${!indexed}`, async () => {
      const f = fixture(true, indexed)
      f.state.indexedReceipt[field] = ({ blockHash: OTHER, blockNumber: 101, transactionIndex: 0, transactionHash: OTHER, status: 0 })[field]
      await assert.rejects(deploymentTransaction(f.rpc, f.recorded))
    })
  }
  test(`rejects inconsistent indexed transaction hash, fallback=${!indexed}`, async () => {
    const f = fixture(indexed, true); f.state.indexedTx.hash = OTHER
    await assert.rejects(deploymentTransaction(f.rpc, f.recorded))
  })
}

test('RPC errors propagate without trusting archived receipts or trying other endpoints', async () => {
  const f = fixture(); const failure = new Error('RPC unavailable')
  f.rpc.getTransactionReceipt = async () => { throw failure }
  await assert.rejects(deploymentTransaction(f.rpc, f.recorded), error => error === failure)
  assert.deepEqual(f.calls, [])
})
