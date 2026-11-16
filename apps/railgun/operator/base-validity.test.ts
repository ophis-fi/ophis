import { afterEach, expect, it, vi } from 'vitest'
import { getBytes, id, toBeHex, toQuantity, Transaction, Wallet, type JsonRpcProvider } from 'ethers'
import { assertBaseValidityUnexpired, createBaseValidityBody, prepareBaseValidity, readBaseValidityBody,
  validateBaseValidityPlan, type BaseValidityPlan } from './base-validity'

afterEach(() => vi.restoreAllMocks())
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const L1 = '0x4200000000000000000000000000000000000015', ORACLE = '0x420000000000000000000000000000000000000f'
function fixture() {
  const wallet = Wallet.createRandom(), timestamp = Math.floor(Date.now() / 1000)
  const head = { number: 100, timestamp, hash: id('Base head') }
  const tx = { type: 2, chainId: 8453, nonce: 0, to: Wallet.createRandom().address, data: '0x', value: 123n,
    gasLimit: 21_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }
  const words = new Map([
    [`${L1}:0x1`, 1_000_000_000n], [`${L1}:0x3`, (1000n << 96n) | (1000n << 64n) | 99n],
    [`${L1}:0x7`, 1n], [`${L1}:0x8`, (500n << 96n) | (7n << 64n) | 9n],
    [`${L1}:${IMPLEMENTATION_SLOT}`, 0x8bde8f549f56d405f07e1aa15df9e1fc69839881n],
    [`${ORACLE}:${IMPLEMENTATION_SLOT}`, 0x4f1db3c6abd250ba86e0928471a8f7db3afd88f1n], [`${ORACLE}:0x0`, 0x01010101n],
  ])
  const provider = { getNetwork: vi.fn(async () => ({ chainId: 8453n })), getBlock: vi.fn(async () => head),
    send: vi.fn(async (method: string, params: unknown[]) => method === 'eth_getBlockByNumber'
      ? { number: toQuantity(head.number), hash: head.hash }
      : toBeHex(words.get(`${params[0]}:${params[1]}`)!, 32)),
  } as unknown as JsonRpcProvider
  const feeExpiryMs = timestamp * 1000 + 30_000
  return { wallet, tx, head, words, provider, feeExpiryMs, prepare: () => prepareBaseValidity(provider, tx, feeExpiryMs) }
}

it('reserves full Fjord/Jovian cost at both price ceilings without sending execution bytes to the read RPC', async () => {
  const f = fixture(), plan = await f.prepare()
  // Minimum Fjord size at doubled prices: L1 cap 3,200,000,000; L2 cap 2,100,000; operator cap 14,700,009.
  expect(plan.maximumCost).toBe('3216800009')
  expect(plan.expiryBlock).toBe(115)
  expect(plan.validity).toHaveLength(8)
  expect(plan.validity.map(item => item.params.op)).toEqual(['<=', '=', '<=', '=', '=', '=', '=', '<='])
  expect(plan.validity[0].params.value).toBe('0x77359400')
  expect(plan.validity[2].params.value).toBe('0x2')
  expect(plan.validity[1].params.value).toBe(`0x${((1000n << 96n) | (1000n << 64n)).toString(16)}`)
  expect(plan.validity[3].params.value).toBe(`0x${((7n << 64n) | 9n).toString(16)}`)
  expect(f.provider.send).toHaveBeenCalledTimes(8)
  expect(f.provider.send).toHaveBeenLastCalledWith('eth_getBlockByNumber', ['0x64', false])
  for (const [method, params] of vi.mocked(f.provider.send).mock.calls.slice(0, 7)) {
    expect(method).toBe('eth_getStorageAt')
    expect((params as unknown[])[2]).toEqual({ blockHash: f.head.hash, requireCanonical: true })
    expect([L1, ORACLE]).toContain((params as string[])[0])
  }
  expect(Object.isFrozen(plan)).toBe(true)
  expect(Object.isFrozen(plan.validity[0].params)).toBe(true)
})

it('round-trips a persisted plan and exact signed official RPC envelope', async () => {
  const f = fixture(), plan = await f.prepare(), restored = validateBaseValidityPlan(JSON.parse(JSON.stringify(plan)), plan.unsigned)
  const raw = await f.wallet.signTransaction(f.tx), body = createBaseValidityBody(raw, restored)
  expect(JSON.parse(body)).toEqual({ jsonrpc: '2.0', id: 1, method: 'base_sendRawTransactionValidity', params: [raw, { validity: plan.validity }] })
  expect(readBaseValidityBody(body, raw)).toEqual({ raw, hash: Transaction.from(raw).hash,
    maximumNetworkCost: BigInt(plan.maximumCost), expiryBlock: 115 })
  expect(() => assertBaseValidityUnexpired(body, raw, 114n)).not.toThrow()
  expect(() => assertBaseValidityUnexpired(body, raw, 115n)).toThrow('expired')
  vi.spyOn(Date, 'now').mockReturnValue(f.feeExpiryMs + 1)
  expect(createBaseValidityBody(raw, restored)).toBe(body)
  expect(validateBaseValidityPlan(restored)).toEqual(restored)
})

it('restores expired legacy equality plans and bodies without changing predicates, cost or bytes', async () => {
  const f = fixture(), legacy = JSON.parse(JSON.stringify(await f.prepare())) as BaseValidityPlan
  // The exact pre-ceiling policy: original observed prices and its original reservation.
  for (const index of [0, 2]) Object.assign(legacy.validity[index].params, {
    op: '=', value: `0x${f.words.get(`${L1}:${index === 0 ? '0x1' : '0x7'}`)!.toString(16)}`,
  })
  legacy.maximumCost = '1616800009'
  const savedPlan = JSON.stringify(legacy), raw = await f.wallet.signTransaction(f.tx)
  const savedBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'base_sendRawTransactionValidity', params: [raw, { validity: legacy.validity }] })
  vi.spyOn(Date, 'now').mockReturnValue(f.feeExpiryMs + 1)
  const restored = validateBaseValidityPlan(JSON.parse(savedPlan), legacy.unsigned)
  expect(JSON.stringify(restored)).toBe(savedPlan)
  expect(createBaseValidityBody(raw, restored)).toBe(savedBody)
  expect(readBaseValidityBody(savedBody, raw).maximumNetworkCost).toBe(1_616_800_009n)
  expect(() => assertBaseValidityUnexpired(savedBody, raw, 115n)).toThrow('expired')
})

it('admits observed L1-origin price changes below ceilings while retaining the full maximum cost', async () => {
  const f = fixture()
  Object.assign(f.tx, { nonce: 1, value: 0n, gasLimit: 23_100n, maxFeePerGas: 13_924_275n, maxPriorityFeePerGas: 1_265_625n })
  f.words.set(`${L1}:0x1`, 215_624_129n)
  f.words.set(`${L1}:0x7`, 13_207_407n)
  f.words.set(`${L1}:0x3`, (2269n << 96n) | (1_055_762n << 64n) | 99n)
  f.words.set(`${L1}:0x8`, 500n << 96n)
  const plan = await f.prepare(), baseCeiling = BigInt(plan.validity[0].params.value), blobCeiling = BigInt(plan.validity[2].params.value)
  expect(plan.maximumCost).toBe('326005131861')
  // Sanitized public observations from cleanup-readonly-price-snapshots.json: first candidate block, +10, expiry.
  // They establish real price drift, not the cause of the absent transaction receipt.
  const observations = [[215_624_129n, 13_207_407n], [217_586_119n, 13_507_063n], [213_306_552n, 13_507_063n]]
  for (const [base, blob] of [...observations, [baseCeiling, blobCeiling]]) {
    expect(base <= baseCeiling && blob <= blobCeiling).toBe(true)
    // Independent minimum-size Fjord formula for this small transfer; operator parameters are pinned to zero.
    const actualL1 = (2269n * base * 16n + 1_055_762n * blob) / 10_000n
    for (const gasUsed of [21_000n, f.tx.gasLimit]) {
      const fullCost = gasUsed * f.tx.maxFeePerGas + actualL1
      expect(fullCost).toBeLessThanOrEqual(BigInt(plan.maximumCost))
    }
  }
  expect(observations.slice(1).every(([base, blob]) => base !== observations[0][0] && blob !== observations[0][1])).toBe(true)
  for (const index of [0, 2]) {
    const ceiling = BigInt(plan.validity[index].params.value)
    expect(ceiling + 1n <= ceiling).toBe(false)
    const changed = JSON.parse(JSON.stringify(plan)) as BaseValidityPlan
    changed.validity[index].params.value = `0x${(ceiling + 100_000_000n).toString(16)}`
    expect(() => validateBaseValidityPlan(changed)).toThrow('cost or encoding')
  }
})

it('requires a greater-than contradiction for an upper-bound exclusion test and rejects extra production predicates', async () => {
  const f = fixture(), plan = await f.prepare(), raw = await f.wallet.signTransaction(f.tx)
  for (const index of [0, 2]) {
    const envelope = JSON.parse(createBaseValidityBody(raw, plan)), original = envelope.params[1].validity[index]
    expect(original.params.op).toBe('<=')
    const ceiling = BigInt(original.params.value)
    const contradiction = { ...original, params: { ...original.params, op: '>' } }
    for (const actual of [0n, ceiling / 2n, ceiling, ceiling + 1n, (1n << 256n) - 1n])
      expect(actual <= ceiling && actual > BigInt(contradiction.params.value)).toBe(false)
    // Flipping a bit while retaining <= would accept the observed price, so it is not an exclusion test.
    expect(ceiling / 2n <= ceiling && ceiling / 2n <= (ceiling ^ 1n)).toBe(true)
    envelope.params[1].validity.push(contradiction)
    expect(() => readBaseValidityBody(JSON.stringify(envelope), raw)).toThrow('invalid encoding')
  }
})

it('keeps fee words on one block across an A-to-B-to-A reorg', async () => {
  const f = fixture(), read = vi.mocked(f.provider.send).getMockImplementation()!, canonical = f.words.get(`${L1}:0x3`)!
  vi.mocked(f.provider.send).mockImplementation(async (method, params) => {
    const args = params as unknown[]
    if (method === 'eth_getStorageAt') {
      if (typeof args[2] === 'string' && args[1] === '0x3') return toBeHex(canonical ^ (1n << 96n), 32)
      expect(args[2]).toEqual({ blockHash: f.head.hash, requireCanonical: true })
    }
    return read(method, params)
  })
  const plan = await f.prepare()
  expect(BigInt(plan.validity[1].params.value)).toBe(canonical & (((1n << 64n) - 1n) << 64n))
})

it('rejects an orphaned fee snapshot even when ethers keeps returning the cached head', async () => {
  const f = fixture(), read = vi.mocked(f.provider.send).getMockImplementation()!
  vi.mocked(f.provider.send).mockImplementation(async (method, params) => method === 'eth_getBlockByNumber'
    ? { number: toQuantity(f.head.number), hash: id('reorg after storage') } : read(method, params))
  await expect(f.prepare()).rejects.toThrow()
})

it('refuses a provider without canonical hash selectors instead of falling back to numbered reads', async () => {
  const f = fixture(), read = vi.mocked(f.provider.send).getMockImplementation()!
  vi.mocked(f.provider.send).mockImplementation(async (method, params) => {
    if (method === 'eth_getStorageAt' && typeof (params as unknown[])[2] === 'object') throw new Error('Hash selector unsupported')
    return read(method, params)
  })
  const result = f.prepare()
  await expect(result).rejects.toThrow('Base historical fee storage is unavailable.')
  await expect(result).rejects.not.toThrow('Hash selector unsupported')
})

it.each(['legacy', 'l1-implementation', 'oracle-implementation', 'missing-word', 'reorg', 'wrong-chain', 'expired'])('refuses unsupported or changed fee state: %s', async kind => {
  const f = fixture()
  if (kind === 'legacy') f.words.set(`${ORACLE}:0x0`, 0x010101n)
  if (kind === 'l1-implementation') f.words.set(`${L1}:${IMPLEMENTATION_SLOT}`, 1n)
  if (kind === 'oracle-implementation') f.words.set(`${ORACLE}:${IMPLEMENTATION_SLOT}`, 1n)
  if (kind === 'missing-word') vi.mocked(f.provider.send).mockResolvedValue('0x')
  if (kind === 'reorg') {
    const read = vi.mocked(f.provider.send).getMockImplementation()!
    vi.mocked(f.provider.send).mockImplementation(async (method, params) => method === 'eth_getBlockByNumber'
      ? { number: toQuantity(f.head.number), hash: id('changed') } : read(method, params))
  }
  if (kind === 'wrong-chain') vi.mocked(f.provider.getNetwork).mockResolvedValue({ chainId: 1n } as Awaited<ReturnType<JsonRpcProvider['getNetwork']>>)
  if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(f.feeExpiryMs + 1)
  await expect(f.prepare()).rejects.toThrow()
})

it.each(['undercharge', 'unsigned', 'mask', 'missing-predicate', 'operator', 'mixed-price-operators', 'unknown-field', 'expiry'])('rejects altered persisted plans: %s', async kind => {
  const f = fixture(), plan = JSON.parse(JSON.stringify(await f.prepare())) as BaseValidityPlan
  if (kind === 'undercharge') plan.maximumCost = (BigInt(plan.maximumCost) - 1n).toString()
  if (kind === 'unsigned') plan.unsigned = Transaction.from({ ...f.tx, gasLimit: 21_001n }).unsignedSerialized
  if (kind === 'mask') Object.assign(plan.validity[1].params, { mask: '0xffff' })
  if (kind === 'missing-predicate') plan.validity.splice(3, 1)
  if (kind === 'operator') Object.assign(plan.validity[1].params, { op: '<=' })
  if (kind === 'mixed-price-operators') Object.assign(plan.validity[0].params, { op: '=' })
  if (kind === 'unknown-field') Object.assign(plan, { ignored: true })
  if (kind === 'expiry') plan.expiryBlock++
  expect(() => validateBaseValidityPlan(plan)).toThrow()
})

it('binds the exact unsigned envelope and refuses raw-only or modified replay', async () => {
  const f = fixture(), plan = await f.prepare(), raw = await f.wallet.signTransaction(f.tx)
  const other = await f.wallet.signTransaction({ ...f.tx, value: f.tx.value + 1n })
  expect(() => createBaseValidityBody(other, plan)).toThrow('unsigned transaction')
  expect(() => createBaseValidityBody(plan.unsigned, plan)).toThrow('signed envelope')
  const body = createBaseValidityBody(raw, plan), changed = JSON.parse(body)
  changed.method = 'eth_sendRawTransaction'
  expect(() => readBaseValidityBody(JSON.stringify(changed), raw)).toThrow('encoding')
  expect(() => readBaseValidityBody(body, other)).toThrow('changed')
})

it('sanitizes malformed durable bodies without disclosing signed transaction bytes', () => {
  for (const malformed of ['private-signed-bytes', JSON.stringify({ params: ['0x02deadbeef-private-signed-bytes'] })]) {
    expect(() => readBaseValidityBody(malformed)).toThrow('Base validity envelope changed or has invalid encoding.')
  }
})

it('bounds nonempty type-2 contract creation for the explicit guard deployment flow', async () => {
  const f = fixture(), tx = { ...f.tx, to: null, data: '0x600060005360016000f3', value: 0n, gasLimit: 100_000n }
  const plan = await prepareBaseValidity(f.provider, tx, f.feeExpiryMs)
  const raw = await f.wallet.signTransaction(tx), body = createBaseValidityBody(raw, plan)
  expect(readBaseValidityBody(body, raw).maximumNetworkCost).toBe(BigInt(plan.maximumCost))
  expect(BigInt(plan.maximumCost)).toBeGreaterThan(tx.gasLimit * tx.maxFeePerGas)
  await expect(prepareBaseValidity(f.provider, { ...tx, data: '0x' }, f.feeExpiryMs)).rejects.toThrow('type-2')
})

it('limits the inclusion window to the authenticated quote at the slower supported block cadence', async () => {
  const f = fixture(), expiryMs = f.head.timestamp * 1000 + 4_000
  const plan = await prepareBaseValidity(f.provider, f.tx, expiryMs)
  expect(plan.expiryBlock).toBe(102)
  expect(f.head.timestamp * 1000 + (plan.expiryBlock - plan.headNumber) * 2000).toBe(expiryMs)
  const longer = await prepareBaseValidity(f.provider, f.tx, f.head.timestamp * 1000 + 240_000)
  expect(longer.expiryBlock).toBe(200)
  expect(() => validateBaseValidityPlan({ ...longer, expiryBlock: 201 })).toThrow()
})

it('bounds signed type-2 RLP across list-length prefix boundaries', async () => {
  const f = fixture()
  for (const size of [0, 1, 14, 31, 32, 40, 170, 180, 190, 200, 65_490, 65_520]) {
    const tx = { ...f.tx, data: `0x${'ab'.repeat(size)}` }, unsigned = Transaction.from(tx).unsignedSerialized
    const raw = await f.wallet.signTransaction(tx)
    expect(getBytes(raw).length).toBeLessThanOrEqual(getBytes(unsigned).length + 68)
  }
})

it('bounds published FastLZ literal/match encodings including split-run and long-match boundaries', () => {
  // Independent token accounting from Base v1.5.4 flz.rs:102-124; a match consumes cmp_len + 2 bytes.
  const literals = (size: number) => 33 * Math.floor(size / 32) + (size % 32 ? size % 32 + 1 : 0)
  for (const left of [0, 1, 31, 32, 33, 255]) for (const right of [0, 1, 31, 32, 33, 255]) {
    for (const length of [1, 2, 6, 7, 261, 262, 263, 524, 8000]) {
      const encodedMatch = 3 * Math.floor((length - 1) / 262) + ((length - 1) % 262 >= 6 ? 3 : 2)
      const size = left + length + 2 + right
      expect(encodedMatch).toBeLessThanOrEqual(length + 1)
      expect(literals(left) + encodedMatch + literals(right)).toBeLessThanOrEqual(size + Math.ceil(size / 32))
    }
  }
})

it('rejects authorizations, other transaction types, and overflowing full-cost arithmetic', async () => {
  const f = fixture()
  await expect(prepareBaseValidity(f.provider, { ...f.tx, type: 4,
    authorizationList: [await f.wallet.authorize({ chainId: 8453, nonce: 0, address: f.tx.to })] }, f.feeExpiryMs)).rejects.toThrow('type-2')
  f.words.set(`${L1}:0x1`, (1n << 256n) - 1n)
  await expect(f.prepare()).rejects.toThrow('permitted range')
})
