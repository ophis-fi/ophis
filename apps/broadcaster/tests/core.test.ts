import { describe, expect, it, vi, afterAll } from 'vitest'
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
import { mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import * as ed from '@noble/ed25519'
import { encryptDataWithSharedKey, tryDecryptJSONDataWithSharedKey } from '@railgun-community/wallet'
import { getAddress, Interface, type JsonRpcProvider } from 'ethers'
import { settings, TOKENS } from '../src/config'
import { Store, initializeSecrets, readSecrets } from '../src/storage'
import { checkedAnswer, FeeOracle, issueFee, validateFee } from '../src/fees'
import { encryptResponse, openRequest, responseEnvelope } from '../src/wire'
import { assertTraceSuccess, parseRequest } from '../src/transaction'
import { config, withdrawalRequest } from './request.fixture'

describe('operator configuration and money boundaries', () => {
  it('rejects non-atomic withdrawals and preserves the one-time withdrawal gate across restarts', async () => {
    const recipient = '0x0000000000000000000000000000000000001234'
    for (const [count, unshield] of [[2, 1], [1, 0]]) {
      const request = await withdrawalRequest('a'.repeat(64), 'b'.repeat(64), recipient, count, unshield)
      expect(() => parseRequest(request, recipient, config)).toThrow('must share one proof')
    }
    const directory = mkdtempSync(join(tmpdir(), 'withdrawal-pilot-gate-'))
    let store = new Store(directory)
    try {
      store.signed('one', 'envelope', 'raw', 'hash', 1n, 10n, 0, '{}', 0, true)
      store.close(); store = new Store(directory)
      expect(() => store.signed('two', 'envelope', 'raw', 'hash2', 1n, 10n, 1, '{}', 0, true))
        .toThrow('withdrawal pilot is already used')
      expect(store.get('two')).toBeUndefined()
      expect(store.exposure()).toBe(1n)
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
    expect(() => settings({ OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT: '0x0000000000000000000000000000000000000000' }))
      .toThrow('withdrawal pilot requires a public recipient')
  })
  it('defaults to unarmed and requires explicit gas budgets before enabling', () => {
    expect(settings({}).enabled).toBe(false)
    expect(settings({}).marginBps).toBe(0n)
    expect(() => settings({ OPHIS_BROADCASTER_ENABLED: '1' })).toThrow('Enabling requires')
    expect(() => settings({ OPHIS_BROADCASTER_MODE: 'fork' })).toThrow('loopback')
    expect(() => settings({ OPHIS_BROADCASTER_WAKU: 'https://public.example' })).toThrow('private local')
    expect(() => settings({ OPHIS_BROADCASTER_MAX_TX_COST_WEI: '-1' })).toThrow('Invalid')
  })
  it('requires a positive margin, guard and restricted account for a mainnet pilot', () => {
    const env = { OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '1000000000',
      OPHIS_BROADCASTER_MAX_TX_COST_WEI: '5000000000000000', OPHIS_BROADCASTER_RESERVE_WEI: '5000000000000000',
      OPHIS_BROADCASTER_DAILY_BUDGET_WEI: '5000000000000000' }
    expect(() => settings(env)).toThrow('positive margin')
    const priced = { ...env, OPHIS_BROADCASTER_MARGIN_BPS: '1500' }
    expect(() => settings(priced)).toThrow('restricted to an explicit pilot')
    const guarded = { ...priced, OPHIS_BROADCASTER_EXECUTION_GUARD: '0x0000000000000000000000000000000000001234' }
    expect(() => settings(guarded)).toThrow('restricted to an explicit pilot')
    expect(() => settings({ ...guarded, OPHIS_BROADCASTER_PILOT_ACCOUNT: '0x0000000000000000000000000000000000005678' }))
      .toThrow('verified dedicated gas-wallet address')
    expect(settings({ ...guarded, OPHIS_BROADCASTER_PILOT_ACCOUNT: '0x0000000000000000000000000000000000005678',
      OPHIS_BROADCASTER_OPERATOR_ADDRESS: '0x0000000000000000000000000000000000007890' }).enabled).toBe(true)
    expect(settings({ ...env, OPHIS_BROADCASTER_ENABLED: '0' }).enabled).toBe(false)
  })
  it('requires explicit public admission without conflicting pilot restrictions and retains mainnet signing safeguards', () => {
    expect(settings({}).admission).toBe('pilot')
    expect(() => settings({ OPHIS_BROADCASTER_ADMISSION: 'anything' })).toThrow('admission')
    const env = { OPHIS_BROADCASTER_ADMISSION: 'public', OPHIS_BROADCASTER_ENABLED: '1',
      OPHIS_BROADCASTER_MARGIN_BPS: '1500', OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '500000000',
      OPHIS_BROADCASTER_MAX_TX_COST_WEI: '1500000000000000', OPHIS_BROADCASTER_RESERVE_WEI: '1500000000000000',
      OPHIS_BROADCASTER_DAILY_BUDGET_WEI: '1500000000000000',
      OPHIS_BROADCASTER_OPERATOR_ADDRESS: '0x0000000000000000000000000000000000007890' }
    expect(() => settings(env)).toThrow('execution guard')
    const guarded = { ...env, OPHIS_BROADCASTER_EXECUTION_GUARD: '0x0000000000000000000000000000000000001234' }
    expect(settings(guarded).admission).toBe('public')
    expect(settings({ ...guarded, OPHIS_BROADCASTER_MODE: 'fork', OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:8559' }).admission).toBe('public')
    expect(() => settings({ ...guarded, OPHIS_BROADCASTER_OPERATOR_ADDRESS: undefined })).toThrow('dedicated gas-wallet')
    for (const field of ['OPHIS_BROADCASTER_PILOT_ACCOUNT', 'OPHIS_BROADCASTER_PILOT_WITHDRAWAL_RECIPIENT'])
      expect(() => settings({ ...guarded, [field]: '0x0000000000000000000000000000000000005678' })).toThrow('pilot restrictions')
  })
  it('persists exact integer budget reservations and preserves unknown transactions across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ophis-broadcast-store-'))
    try {
      let store = new Store(directory)
      const cost = 9_007_199_254_740_993n
      store.signed('one', 'encrypted request', 'signed raw', 'hash', cost, cost * 2n, 0)
      expect(store.exposure()).toBe(cost)
      expect(() => store.signed('one', 'other', 'other', 'hash2', 1n, cost * 2n, 0)).toThrow('already journaled')
      expect(() => store.signed('two', 'other', 'other', 'hash2', cost + 1n, cost * 2n, 1)).toThrow('budget exhausted')
      store.close(); store = new Store(directory)
      expect(store.get('one')?.raw).toBe('signed raw')
      expect(store.exposure()).toBe(cost)
      store.confirmed('one', cost - 123n, Date.now())
      expect(store.exposure()).toBe(cost - 123n)
      store.close()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('enforces the settlement gate atomically across independent journal connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ophis-settlement-gate-'))
    const first = new Store(directory), second = new Store(directory)
    try {
      first.signed('one', 'envelope', 'raw', 'hash', 1n, 10n, 0)
      expect(() => second.signed('two', 'envelope', 'raw2', 'hash2', 1n, 10n, 1)).toThrow('unresolved transaction')
      first.confirmed('one', 1n, Date.now())
      expect(() => second.signed('two', 'envelope', 'raw2', 'hash2', 1n, 10n, 1)).toThrow('unresolved transaction')
      first.assured('one')
      expect(first.nonceBlocked(0)).toBe(true)
      expect(() => second.signed('reorg', 'envelope', 'raw2', 'hash2', 1n, 10n, 0)).toThrow('already reserved')
      expect(() => second.signed('two', 'envelope', 'raw2', 'hash2', 1n, 10n, 1)).not.toThrow()
      expect(first.pending().map((r) => r.key)).toEqual(['two'])
    } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('creates independent private operator secrets without overwriting or accepting loose permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ophis-broadcast-secrets-'))
    try {
      const file = join(directory, 'operator.json')
      expect(initializeSecrets(file, 'fork')).toMatch(/^0x[0-9a-f]{40}$/i)
      expect(readSecrets(file).encryptionKey).toMatch(/^[0-9a-f]{64}$/)
      expect(() => initializeSecrets(file, 'fork')).toThrow()
      chmodSync(file, 0o644)
      expect(() => readSecrets(file)).toThrow('Invalid or inaccessible')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('refuses production file-key creation without writing any secrets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ophis-mainnet-key-hold-'))
    const file = join(directory, 'operator.json')
    try {
      expect(() => initializeSecrets(file, 'mainnet')).toThrow('Create production keys outside the broadcaster')
      expect(existsSync(file)).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
  it('rejects invalid, future and stale oracle answers', () => {
    expect(checkedAnswer([5n, 100n, 0n, 990n, 5n], 1000, 60)).toBe(100n)
    for (const round of [[5n, 0n, 0n, 990n, 5n], [5n, 1n, 0n, 1001n, 5n], [5n, 1n, 0n, 900n, 5n], [5n, 1n, 0n, 990n, 4n]])
      expect(() => checkedAnswer(round, 1000, 60)).toThrow('stale or invalid')
  })
  it('quotes WETH and stablecoin reimbursement at the selected gas markup', async () => {
    const feed = new Interface(['function decimals() view returns (uint8)', 'function description() view returns (string)',
      'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'])
    const now = Math.floor(Date.now() / 1000)
    const names = ['eth-usd.data.eth', 'usdc-usd.data.eth', 'usdt-usd.data.eth']
    const provider = {
      resolveName: async (name: string) => `0x${String(names.indexOf(name) + 1).padStart(40, '0')}`,
      getCode: async () => '0x6001', getBlock: async () => ({ number: 100, timestamp: now }),
      call: async ({ to, data }: { to: string; data: string }) => {
        const index = Number(BigInt(to)) - 1
        const method = feed.parseTransaction({ data })!.name
        if (method === 'decimals') return feed.encodeFunctionResult(method, [8])
        if (method === 'description') return feed.encodeFunctionResult(method, [['ETH / USD', 'USDC / USD', 'USDT / USD'][index]])
        return feed.encodeFunctionResult(method, [1, index === 0 ? 2300_00000000n : 100000000n, now, now, 1])
      },
    } as unknown as JsonRpcProvider
    const rates = await new FeeOracle(provider, 1500n).rates()
    expect(rates[getAddress(TOKENS[0].address)]).toBe(1_150_000_000_000_000_000n)
    expect(rates[getAddress(TOKENS[1].address)]).toBe(2_645_000_000n)
    expect(rates[getAddress(TOKENS[2].address)]).toBe(2_645_000_000n)
  })
  it('requires a live issued quote, supported single-token payment and enough gas reimbursement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ophis-broadcast-fees-'))
    const store = new Store(directory)
    try {
      const rates = { [TOKENS[0].address]: 10n ** 18n }
      const quote = issueFee(store, rates)
      expect(() => validateFee(store, quote.id, { [TOKENS[0].address]: 1000n }, 1000n, rates)).not.toThrow()
      expect(() => validateFee(store, quote.id, { [TOKENS[0].address]: 999n }, 1000n, rates)).toThrow('does not cover')
      const markedUp = { [TOKENS[1].address]: 2_300_000_001n }
      const fractional = issueFee(store, markedUp)
      const maximumCost = 1_000_000_001n
      expect(() => validateFee(store, fractional.id, { [TOKENS[1].address]: 2n }, maximumCost, markedUp)).toThrow('does not cover')
      expect(() => validateFee(store, fractional.id, { [TOKENS[1].address]: 3n }, maximumCost, markedUp)).not.toThrow()
      expect(() => validateFee(store, quote.id, { [TOKENS[0].address]: 1000n, [TOKENS[1].address]: 1n }, 1000n, rates)).toThrow('single')
      expect(() => validateFee(store, 'unknown', { [TOKENS[0].address]: 1000n }, 1000n, rates)).toThrow('expired')
      store.db.prepare('UPDATE fees SET expiration=0 WHERE id=?').run(quote.id)
      expect(() => validateFee(store, quote.id, { [TOKENS[0].address]: 1000n }, 1000n, rates)).toThrow('expired')
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('SDK encrypted wire format', () => {
  it('decrypts SDK requests, deduplicates changed RPC ids and returns SDK-decryptable responses', async () => {
    const privateKey = randomBytes(32), publicKey = await ed.getPublicKey(privateKey)
    const encrypted = await encryptDataWithSharedKey({ broadcasterViewingKey: Buffer.from(publicKey).toString('hex'), hello: 'world' }, publicKey)
    const packet = { method: 'transact', id: 1, params: { pubkey: encrypted.randomPubKey, encryptedData: encrypted.encryptedData } }
    const request = await openRequest(Buffer.from(JSON.stringify(packet)), privateKey, Buffer.from(publicKey).toString('hex'))
    expect(request?.data.hello).toBe('world')
    const duplicate = await openRequest(Buffer.from(JSON.stringify({ ...packet, id: 99 })), privateKey, Buffer.from(publicKey).toString('hex'))
    expect(duplicate?.key).toBe(request?.key)
    const body = JSON.parse(Buffer.from(responseEnvelope(encryptResponse({ txHash: 'test-hash' }, request!), 99)).toString())
    expect(body.id).toBe(99)
    expect(tryDecryptJSONDataWithSharedKey(body.result, encrypted.sharedKey)).toEqual({ txHash: 'test-hash' })
    expect(await openRequest(Buffer.from(JSON.stringify(packet)), randomBytes(32), Buffer.from(publicKey).toString('hex'))).toBeUndefined()
    expect(await openRequest(Buffer.from('not JSON'), privateKey, Buffer.from(publicKey).toString('hex'))).toBeUndefined()
  })
  it('rejects nested simulation failures even if the outer delegated transaction succeeded', () => {
    expect(() => assertTraceSuccess({ type: 'CALL', calls: [{ type: 'CALL', error: 'revert' }] })).toThrow('simulation failed')
    expect(() => assertTraceSuccess({ type: 'CALL', calls: 'malformed' })).toThrow('Malformed')
    expect(() => assertTraceSuccess({ type: 'CALL', calls: [{ type: 'STATICCALL' }] })).not.toThrow()
  })
})
