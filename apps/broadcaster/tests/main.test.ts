import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
// These fixtures model Ethereum explicitly; chain-specific suites exercise the BNB policy separately.
const originalFixtureChain = vi.hoisted(() => {
  const previous = process.env.OPHIS_BROADCASTER_CHAIN_ID
  process.env.OPHIS_BROADCASTER_CHAIN_ID = '1'
  return previous
})
afterAll(() => {
  if (originalFixtureChain === undefined) delete process.env.OPHIS_BROADCASTER_CHAIN_ID
  else process.env.OPHIS_BROADCASTER_CHAIN_ID = originalFixtureChain
})
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/storage'
import { CreditLedger } from '../src/credit'
import { id, Wallet, JsonRpcProvider, Transaction } from 'ethers'
import { finalizedCreditReceipt } from '../src/credit-payment'
import { cliBacking } from './main-sdk.fixture'
import { NETWORK, TOKENS } from '../src/config'
import { PROXY } from '../src/transaction'
import { ANON_COLLECTION_GATEWAY } from '../src/anon-native-collection'
const anonRuntime = readFileSync(new URL('./fixtures/anon-gateway-runtime.hex', import.meta.url), 'utf8').trim()

const testGasKey = id('public disposable CLI unit test gas key')
const operator = new Wallet(testGasKey).address
const otherOperator = '0x0000000000000000000000000000000000005678'
let directory: string, executable: string, port: number, readChain = 1
let health: Record<string, unknown>
let payoutNullifiers: string[] = [], rpcMethods: string[] = []
beforeEach(() => { payoutNullifiers = []; rpcMethods = [] })
const payoutHash = id('CLI owner payout'), payoutBlock = id('CLI finalized block'), refundKey = id('CLI saved refund')
const feeRecipient = '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
const refundRecipient = '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm'
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/health') { response.end(JSON.stringify(health)); return }
  let body = ''
  for await (const chunk of request) body += chunk
  const call = JSON.parse(body)
  rpcMethods.push(call.method)
  const result = call.method === 'eth_chainId' ? `0x${readChain.toString(16)}`
    : call.method === 'eth_getTransactionCount' ? '0x3'
    : call.method === 'eth_getCode' ? (call.params[0].toLowerCase() === ANON_COLLECTION_GATEWAY.toLowerCase() ? anonRuntime : '0x')
    : call.method === 'eth_call' ? `0x${(call.params[0].to.toLowerCase() === ANON_COLLECTION_GATEWAY.toLowerCase() ? 'd' : '19').padStart(64, '0')}`
    : call.method === 'anvil_metadata' ? { forkedNetwork: { chainId: readChain } }
    : call.method === 'eth_getTransactionReceipt' && call.params[0] === payoutHash ? {
      to: operator, from: otherOperator, contractAddress: null, transactionIndex: '0x0', gasUsed: '0x186a0',
      cumulativeGasUsed: '0x186a0', logsBloom: `0x${'00'.repeat(256)}`, blockHash: payoutBlock,
      transactionHash: payoutHash, logs: payoutNullifiers.length ? [{
        ...PROXY.encodeEventLog(PROXY.getEvent('Nullified')!, [0, payoutNullifiers]), address: NETWORK.proxyContract,
        transactionHash: payoutHash, blockHash: payoutBlock, blockNumber: '0xa', transactionIndex: '0x0', logIndex: '0x0', removed: false,
      }] : [], blockNumber: '0xa', status: '0x1', effectiveGasPrice: '0x1', type: '0x2',
    } : call.method === 'eth_getBlockByNumber' ? { hash: payoutBlock, parentHash: id('parent'), number: '0xa',
      timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380',
      gasUsed: '0x186a0', miner: operator, extraData: '0x', transactions: [], baseFeePerGas: '0x1' } : undefined
  response.end(JSON.stringify(result === undefined
    ? { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Unsupported fixture method' } }
    : { jsonrpc: '2.0', id: call.id, result }))
})

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ophis-main-cli-'))
  executable = join(directory, 'main.mjs')
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir')
  await build({ entryPoints: [new URL('../src/main.ts', import.meta.url).pathname], outfile: executable,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'fixture-sdk', setup(builder) {
      builder.onResolve({ filter: /^\.\/sdk$/ }, (args) => args.importer.endsWith('/src/main.ts')
        ? { path: new URL('./main-sdk.fixture.ts', import.meta.url).pathname } : undefined)
    } }, { name: 'fixture-free-disk', setup(builder) {
      builder.onResolve({ filter: /^node:fs$/ }, (args) => args.namespace === 'fixture-free-disk'
        ? { path: 'node:fs', external: true } : { path: 'fs', namespace: 'fixture-free-disk' })
      builder.onLoad({ filter: /.*/, namespace: 'fixture-free-disk' }, () => ({
        contents: "export * from 'node:fs'; export const statfsSync = () => ({ bavail: 8 * 1024 ** 3, bsize: 1 });",
      }))
    } }],
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing disposable loopback port.')
  port = address.port
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  rmSync(directory, { recursive: true, force: true })
})

async function report(chainId: number, boundChain: number | null = chainId, boundOperator = operator, command = ['report'],
  prepare?: (store: Store) => void | Promise<void>) {
  const state = mkdtempSync(join(directory, 'state-'))
  const store = new Store(state)
  try { if (boundChain !== null) store.bindIdentity(boundChain, boundOperator); await prepare?.(store) } finally { store.close() }
  if (['prepare-owner-operation', 'reject-unrelated-owner-payout'].includes(command[0])) writeFileSync(join(state, 'unused-test-only.json'),
    JSON.stringify({ gasKey: testGasKey, feeViewingKey: '11'.repeat(64), encryptionKey: '22'.repeat(32) }), { mode: 0o600 })
  const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
    OPHIS_BROADCASTER_MODE: 'fork', OPHIS_BROADCASTER_ENABLED: '0', OPHIS_BROADCASTER_CHAIN_ID: String(chainId),
    OPHIS_BROADCASTER_RPC: `http://127.0.0.1:${port}`, OPHIS_BROADCASTER_PORT: String(port),
    OPHIS_BROADCASTER_STATE: state, OPHIS_BROADCASTER_SECRETS: join(state, 'unused-test-only.json'),
    OPHIS_BROADCASTER_OPERATOR_ADDRESS: operator, OPHIS_BROADCASTER_MARGIN_BPS: '1500',
    OPHIS_BROADCASTER_CREDIT_COLLECTION_INPUTS: '2', OPHIS_BROADCASTER_CREDIT_COLLECTION_OUTPUTS: '4',
    OPHIS_BROADCASTER_CREDIT_COLLECTION_PROOFS: '2',
    OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '100', OPHIS_BROADCASTER_MAX_TX_COST_WEI: '250000000' }
  return new Promise<{ code: string | number | undefined; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [executable, ...command], { env, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? error.name : 0, stdout, stderr }))
  })
}

it('lists and records owner refund payouts through the real CLI without a key file, unlock or signature', async () => {
  readChain = 1
  const prepare = async (store: Store) => {
    const ledger = new CreditLedger(store, { chainId: 1, operator, recipient: feeRecipient, token: TOKENS[0].address })
    ledger.deposit({ owner: otherOperator, amount: 100n, tree: 0, position: 0, commitment: id('CLI deposit'),
      transactionHash: id('CLI topup'), blockHash: id('CLI deposit block'), blockNumber: 1 })
    ledger.reserveRefund(refundKey, otherOperator, refundRecipient, 100n, 90n, ledger.nextSequence(otherOperator), await cliBacking(ledger.accountedNotes()), 1n)
    ledger.prepareOwnerOperation({ kind: 'refund', refundKey, maximumPrivateFee: 1n, minimumNative: 0n,
      inputLimit: 2, outputLimit: 4, proofLimit: 2, marginBps: 1500n }, await cliBacking(ledger.accountedNotes()))
  }
  const listed = await report(1, 1, operator, ['refunds'], prepare)
  expect(listed.code, listed.stderr).toBe(0)
  expect(JSON.parse(listed.stdout)).toMatchObject({ privateOperatorOutput: true,
    pending: [{ key: refundKey, recipient: refundRecipient, gross: '100', net: '90' }] })
  const recorded = await report(1, 1, operator, ['record-refund-payout', refundKey, payoutHash], prepare)
  expect(recorded.code, recorded.stderr).toBe(0)
  expect(JSON.parse(recorded.stdout)).toMatchObject({ status: 'owner-payout-recorded-awaiting-private-verification',
    refundKey, transactionHash: payoutHash, fundsTransferred: false })
})

it.each(['valid', 'wrong-chain', 'wrong-ledger', 'wrong-limits', 'expired', 'above-cost-cap'])(
  'prepares an owner payment through the stopped-service CLI: %s', async (scenario) => {
    readChain = 1
    const quoteFile = join(directory, `owner-intent-${scenario}.json`)
    const result = await report(1, 1, operator, ['prepare-owner-operation', quoteFile], async (store) => {
      const ledger = new CreditLedger(store, { chainId: 1, operator, recipient: feeRecipient, token: TOKENS[0].address })
      ledger.deposit({ owner: otherOperator, amount: 100n, tree: 0, position: 0, commitment: id('intent deposit'),
        transactionHash: id('intent topup'), blockHash: id('intent block'), blockNumber: 1 })
      ledger.reserveRefund(refundKey, otherOperator, refundRecipient, 100n, 90n, ledger.nextSequence(otherOperator), await cliBacking(ledger.accountedNotes()), 1n)
      writeFileSync(quoteFile, JSON.stringify({ kind: 'refund', chainId: scenario === 'wrong-chain' ? 56 : 1,
        ledgerId: scenario === 'wrong-ledger' ? id('other ledger') : ledger.id, operator, token: TOKENS[0].address,
        refundKey, maximumPrivateFee: scenario === 'above-cost-cap' ? '250000001' : '1', minimumNative: '0',
        inputLimit: scenario === 'wrong-limits' ? 1 : 2, outputLimit: 4, proofLimit: 2, marginBps: '1500',
        expiresAt: Date.now() + (scenario === 'expired' ? -1 : 60_000) }), { mode: 0o600 })
    })
    if (scenario === 'valid') {
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'owner-operation-held', fundsTransferred: false,
        intent: { kind: 'refund', refund_key: refundKey, debit: '91', maximum_private_fee: '1' } })
    } else {
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
    }
  },
)


it.each([800_000n, 900_000n])('checks current collection deductions before persisting minimum native %s', async (minimumNative) => {
  readChain = 1
  const planFile = join(directory, `collection-${minimumNative}.json`)
  const result = await report(1, 1, operator, ['prepare-owner-operation', planFile], (store) => {
    const ledger = new CreditLedger(store, { chainId: 1, operator, recipient: feeRecipient, token: TOKENS[0].address })
    ledger.deposit({ owner: otherOperator, amount: 1_000_000n, tree: 0, position: 0, commitment: id('collection CLI note'),
      transactionHash: id('collection CLI topup'), blockHash: id('collection CLI origin'), blockNumber: 1 })
    const key = id('synthetically settled CLI attempt')
    store.db.prepare('INSERT INTO credit_owner_sequences(owner,sequence) VALUES(?,1)').run(otherOperator)
    store.db.prepare('INSERT INTO credit_attempts(key,owner,unsigned,maximum_charge,rate,collection_allowance,charged,settlement_hash,sequence) VALUES(?,?,?,?,?,?,?,?,1)')
      .run(key, otherOperator, Transaction.from({ type: 2, chainId: 1, to: otherOperator, nonce: 0,
        gasLimit: 1000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }).unsignedSerialized, '1000000', '1000000000000000000', '0', '1000000', id('synthetic CLI receipt'))
    store.db.prepare('INSERT INTO requests(key,envelope,created,max_cost,signed_at,fee_data,nonce,confirmed,assured,actual_cost) VALUES(?,?,?,?,?,?,0,1,1,?)')
      .run(key, 'synthetic', Date.now(), '1000', Date.now(), JSON.stringify({ kind: 'prepaid', owner: otherOperator, ledgerId: ledger.id }), '1000')
    writeFileSync(planFile, JSON.stringify({ kind: 'collection', chainId: 1, ledgerId: ledger.id, operator,
      token: TOKENS[0].address, maximumPrivateFee: '100000', minimumNative: minimumNative.toString(),
      inputLimit: 2, outputLimit: 4, proofLimit: 2, marginBps: '1500', expiresAt: Date.now() + 60_000,
      collectionFees: { unshieldFeeBps: '0', gatewayFeeBps: '0' },
    }), { mode: 0o600 })
  })
  expect(result.code, result.stderr).toBe(minimumNative === 800_000n ? 0 : 1)
  if (minimumNative === 800_000n) expect(JSON.parse(result.stdout)).toMatchObject({ status: 'owner-operation-held', fundsTransferred: false })
  else expect(result.stdout).toBe('')
})

it.each(['record-owner-payout', 'reject-owner-payout', 'reject-unrelated-owner-payout'])('%s follows its required synchronization boundary without transferring funds', async (operation) => {
  readChain = 1
  const command = [operation, '', payoutHash]
  if (operation === 'reject-unrelated-owner-payout') payoutNullifiers = [id('unrelated wallet nullifier')]
  const result = await report(1, 1, operator, command, async (store) => {
    const ledger = new CreditLedger(store, { chainId: 1, operator, recipient: feeRecipient, token: TOKENS[0].address })
    ledger.deposit({ owner: otherOperator, amount: 100n, tree: 0, position: 0, commitment: id('associated deposit'),
      transactionHash: id('associated topup'), blockHash: id('associated block'), blockNumber: 1 })
    ledger.reserveRefund(refundKey, otherOperator, refundRecipient, 100n, 90n, ledger.nextSequence(otherOperator), await cliBacking(ledger.accountedNotes()), 1n)
    command[1] = ledger.prepareOwnerOperation({ kind: 'refund', refundKey, maximumPrivateFee: 1n, minimumNative: 0n,
      inputLimit: 2, outputLimit: 4, proofLimit: 2, marginBps: 1500n }, await cliBacking(ledger.accountedNotes())).key
    if (operation !== 'record-owner-payout') {
      const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 1, { batchMaxCount: 1 })
      try { ledger.recordOwnerPayout(command[1], await finalizedCreditReceipt(provider, payoutHash)) } finally { provider.destroy() }
    }
  })
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ status: operation === 'reject-owner-payout'
    ? 'nonspending-owner-payout-rejected-intent-still-held' : operation === 'reject-unrelated-owner-payout'
      ? 'unrelated-owner-payout-rejected-intent-still-held' : 'owner-payout-recorded-awaiting-private-verification',
    intentKey: command[1], transactionHash: payoutHash, fundsTransferred: false })
})

it.each([2_000_000n, 3_000_000n])('preflights a refund-only %s gas budget through the read-only CLI without keys', async (allowance) => {
  readChain = 1
  const quoteFile = join(directory, `owner-quote-${allowance}.json`), deposited = 10n ** 18n
  health = { chainId: 1, nativeSymbol: 'ETH', operatorAddress: operator, synchronized: true,
    feeBalancesAt: Date.now(), feeBalances: { [TOKENS[0].address]: deposited.toString() } }
  const result = await report(1, 1, operator, ['owner-cost-preflight', quoteFile], async (store) => {
    const ledger = new CreditLedger(store, { chainId: 1, operator, recipient: feeRecipient, token: TOKENS[0].address })
    ledger.deposit({ owner: otherOperator, amount: deposited, tree: 0, position: 0, commitment: id('preflight-note'),
      transactionHash: id('preflight-deposit'), blockHash: id('preflight-block'), blockNumber: 1 })
    const denominator = 9975n * 9987n
    const retained = (allowance * 100n * 11_500n * 10_000n + denominator - 1n) / denominator
    ledger.reserveRefund(refundKey, otherOperator, refundRecipient, deposited / 2n, deposited / 2n - retained, ledger.nextSequence(otherOperator), await cliBacking(ledger.accountedNotes()), 1n)
    writeFileSync(quoteFile, JSON.stringify({ kind: 'refund', chainId: 1, operator, ledgerId: ledger.id, token: TOKENS[0].address,
      refundKey, expiresAt: Date.now() + 60_000, costs: Object.fromEntries(Object.entries({
        payout: '1030000', collection: '1110000',
      }).map(([step, gasLimit]) => [step, { gasLimit, maxFeePerGas: '100' }])) }), { mode: 0o600 })
  })
  expect(result.code, result.stderr).toBe(allowance === 2_000_000n ? 2 : 0)
  expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'refund', withinBudget: allowance === 3_000_000n,
    budgetEstimateOnly: true, ownerQuotesVerified: false, fundsTransferred: false })
})

it.each([[1, 'ETH'], [42161, 'ETH'], [56, 'BNB'], [137, 'POL']] as const)(
  'reports chain %i with its bound operator and matching current balance sample', async (chainId, nativeSymbol) => {
    readChain = chainId
    health = { chainId, nativeSymbol, operatorAddress: operator, synchronized: true, feeBalancesAt: Date.now(), feeBalances: {} }
    const result = await report(chainId)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ chainId, nativeSymbol, operatorAddress: operator,
      requests: 0, recordedGasExpenseWei: '0', privateFeeWalletBalances: {}, privateBalanceIncludesCustomerCredit: true })
  },
)

it.each(['journal-chain', 'journal-operator', 'unbound-journal', 'health-chain', 'health-operator', 'rpc-chain'])(
  'refuses a mismatched %s without emitting accounting or private balances', async (kind) => {
    readChain = kind === 'rpc-chain' ? 56 : 1
    health = { chainId: kind === 'health-chain' ? 56 : 1, nativeSymbol: 'ETH',
      operatorAddress: kind === 'health-operator' ? otherOperator : operator,
      synchronized: true, feeBalancesAt: Date.now(), feeBalances: { privateBalanceMustNotLeak: '7' } }
    const result = await report(1, kind === 'unbound-journal' ? null : kind === 'journal-chain' ? 56 : 1,
      kind === 'journal-operator' ? otherOperator : operator)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('No secret values were logged')
    expect(result.stderr).not.toContain('privateBalanceMustNotLeak')
  },
)


async function syncProcess(state: string, options: string[]) {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Missing sync health port.')
  const healthPort = address.port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
    OPHIS_BROADCASTER_MODE: 'fork', OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_CHAIN_ID: '1',
    OPHIS_BROADCASTER_RPC: `http://127.0.0.1:${port}`, OPHIS_BROADCASTER_PORT: String(healthPort),
    OPHIS_BROADCASTER_STATE: state, OPHIS_BROADCASTER_SECRETS: join(state, 'public-test-only.json'),
    OPHIS_BROADCASTER_OPERATOR_ADDRESS: operator,
  }
  let sample: Record<string, unknown> | undefined
  const result = await new Promise<{ code: string | number | undefined; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [executable, 'sync', ...options], { env, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? error.name : 0, stdout, stderr }))
    let output = '', stopping = false
    child.stdout!.on('data', (chunk) => {
      output += chunk
      if (!stopping && /"status":"(?:credit-ledger-ready|sync-ready)"/.test(output)) {
        stopping = true
        void fetch(`http://127.0.0.1:${healthPort}/health`).then(async (response) => {
          sample = await response.json() as Record<string, unknown>
        }).finally(() => child.kill('SIGTERM'))
      }
    })
  })
  return { ...result, sample, records: result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
}

it('keeps plain sync unarmed and initializes the immutable credit identity only on explicit request', async () => {
  readChain = 1
  const state = mkdtempSync(join(directory, 'sync-'))
  const original = new Store(state)
  original.bindIdentity(1, operator)
  original.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('withdrawalPilot', 'historic-used-marker')
  original.close()
  writeFileSync(join(state, 'public-test-only.json'), JSON.stringify({ gasKey: testGasKey,
    feeViewingKey: '11'.repeat(64), encryptionKey: '22'.repeat(32) }), { mode: 0o600 })
  const plain = await syncProcess(state, [])
  expect(plain.code, plain.stderr).toBe(0)
  expect(plain.sample).toMatchObject({ enabled: false, ready: false, synchronized: true, feeBalances: { [TOKENS[0].address]: '7' } })
  expect(plain.records.at(-1)).toMatchObject({ status: 'sync-ready', signingEnabled: false, fundsTransferred: false })
  const inspect = new Store(state)
  expect(inspect.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_identity'").get()).toBeUndefined()
  inspect.close()
  expect(rpcMethods).not.toContain('eth_getTransactionCount')
  let ledgerId = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const initialized = await syncProcess(state, ['--initialize-credit'])
    expect(initialized.code, initialized.stderr).toBe(0)
    expect(initialized.sample).toMatchObject({ enabled: false, ready: false, synchronized: true })
    const ready = initialized.records.at(-1)
    expect(ready).toMatchObject({ status: 'credit-ledger-ready', signingEnabled: false, fundsTransferred: false,
      credit: { executionEnabled: false, scope: { operator, recipient: feeRecipient } } })
    const journal = new Store(state), ledger = CreditLedger.load(journal)
    if (!ledgerId) ledgerId = ledger.id
    expect(ledger.id).toBe(ledgerId)
    expect(ready.credit.ledgerId).toBe(ledgerId)
    expect(journal.db.prepare('SELECT initial_nonce FROM credit_identity').get()?.initial_nonce).toBe(3)
    expect(journal.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe('historic-used-marker')
    expect(journal.db.prepare('SELECT COUNT(*) AS count FROM requests').get()?.count).toBe(0)
    journal.close()
  }
  expect(rpcMethods.some((method) => /send|sign/i.test(method))).toBe(false)
}, 15_000)

it.each([['--unknown'], ['--initialize-credit', '--initialize-credit']])('rejects unsupported sync arguments %j before accessing funds', async (...options) => {
  const state = mkdtempSync(join(directory, 'invalid-sync-'))
  const result = await syncProcess(state, options)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(rpcMethods).toEqual([])
})
