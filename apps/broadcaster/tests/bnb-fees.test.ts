import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet, ZeroAddress, ZeroHash } from 'ethers'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

async function fixture(chainId = 56) {
  vi.resetModules(); vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const config = await import('../src/config')
  const boundary = await import('../src/transaction')
  const requests = await import('./request.fixture')
  const recipient = Wallet.createRandom().address
  const request = await requests.withdrawalRequest('ab'.repeat(32), 'viewing-key', recipient)
  const transactions = boundary.PROXY.decodeFunctionData('transact', request.data)._transactions
    .map((tx: { toObject(): Record<string, any> }) => {
      const row = tx.toObject()
      return { ...row, nullifiers: Array.from(row.nullifiers), commitments: Array.from(row.commitments),
        boundParams: { ...row.boundParams.toObject(), commitmentCiphertext: Array.from(row.boundParams.commitmentCiphertext) },
        unshieldPreimage: { ...row.unshieldPreimage.toObject(), token: row.unshieldPreimage.token.toObject() } }
    }) as Record<string, any>[]
  const parse = (batch = transactions) => boundary.parseRequest({ ...request,
    data: boundary.PROXY.encodeFunctionData('transact', [batch]) }, recipient, requests.config)
  return { config, boundary, requests, recipient, transactions, parse }
}

it('rejects the independently executable mixed COMMON batch and either isolated proof', async () => {
  const f = await fixture()
  for (const batch of [f.transactions, [f.transactions[0]], [f.transactions[1]]])
    expect(() => f.parse(batch)).toThrow('BNB COMMON withdrawals require one WBNB proof')
})

it('accepts only a guarded signed safe stablecoin exit with both proofs bound to its account', async () => {
  const f = await fixture()
  const request = await f.requests.signedWithdrawalRequest('ab'.repeat(32), 'viewing-key', f.recipient)
  const parsed = f.boundary.parseRequest(request, f.recipient, { ...f.requests.config, executionGuard: Wallet.createRandom().address })
  expect(parsed.type4).toBe(true)
  expect(parsed.transactions).toHaveLength(2)
  expect(parsed.transactions.map((tx) => BigInt(tx.boundParams.unshield))).toEqual([0n, 1n])
  expect(parsed.transactions[1].unshieldPreimage.token.tokenAddress).toBe(f.config.TOKENS[1].address)
  expect(parsed.transactions.every((tx) => tx.boundParams.adaptContract === request.to)).toBe(true)
  expect(parsed.withdrawal).toEqual({ recipient: f.recipient, token: f.config.TOKENS[1].address, amount: 1000n, grossAmount: 1000n })
  expect(new Set(parsed.nullifiers).size).toBe(2)
  expect(() => f.boundary.parseRequest(request, f.recipient, f.requests.config)).toThrow('Only guarded withdrawals')
})

it.each(['fee unshield', 'redirect withdrawal', 'missing fee', 'empty fee', 'empty fee inputs', 'empty withdrawal inputs',
  'ciphertext count', 'duplicate nullifier', 'extra proof', 'unknown token', 'NFT', 'token sub-ID', 'zero amount',
  'wrong chain', 'wrong adapt', 'adapt parameters', 'two-proof WBNB', 'public unshield', 'native value',
  'external call', 'extra transfer', 'reshield', 'non-atomic action'])(
  'rejects a validly signed malformed BNB withdrawal before operator signing: %s', async (kind) => {
    const f = await fixture()
    const request = await f.requests.signedWithdrawalRequest('ab'.repeat(32), 'viewing-key', f.recipient,
      f.config.TOKENS[1].address, `0x${'11'.repeat(32)}`, (rows, action) => {
    if (kind === 'fee unshield') rows[0].boundParams.unshield = 1
    if (kind === 'redirect withdrawal') rows[1].boundParams.unshield = 2
    if (kind === 'missing fee') rows.shift()
    if (kind === 'empty fee') { rows[0].commitments = []; rows[0].boundParams.commitmentCiphertext = [] }
    if (kind === 'empty fee inputs') rows[0].nullifiers = []
    if (kind === 'empty withdrawal inputs') rows[1].nullifiers = []
    if (kind === 'ciphertext count') rows[0].boundParams.commitmentCiphertext = []
    if (kind === 'duplicate nullifier') rows[1].nullifiers = rows[0].nullifiers
    if (kind === 'extra proof') rows.push(rows[1])
    if (kind === 'unknown token') rows[1].unshieldPreimage.token.tokenAddress = Wallet.createRandom().address
    if (kind === 'NFT') rows[1].unshieldPreimage.token.tokenType = 1
    if (kind === 'token sub-ID') rows[1].unshieldPreimage.token.tokenSubID = 1
    if (kind === 'zero amount') rows[1].unshieldPreimage.value = 0
    if (kind === 'wrong chain') rows[0].boundParams.chainID = 1
    if (kind === 'wrong adapt') rows[0].boundParams.adaptContract = ZeroAddress
    if (kind === 'adapt parameters') rows[0].boundParams.adaptParams = `0x${'01'.repeat(32)}`
    if (kind === 'two-proof WBNB') rows[1].unshieldPreimage.token.tokenAddress = f.config.TOKENS[0].address
    if (kind === 'public unshield') rows[1].unshieldPreimage.npk = `0x${f.recipient.slice(2).padStart(64, '0')}`
    if (kind === 'native value') action.calls[0].value = 1n
    if (kind === 'external call') action.calls[0].to = f.config.TOKENS[1].address
    if (kind === 'extra transfer') {
      const transfers = Array.from(f.boundary.ADAPT.decodeFunctionData('transfer', action.calls[0].data)[0])
      action.calls[0].data = f.boundary.ADAPT.encodeFunctionData('transfer', [[...transfers, transfers[0]]])
    }
    if (kind === 'reshield') action.calls.push({ to: action.calls[0].to, value: 0n, data: f.boundary.ADAPT.encodeFunctionData('shield', [[]]) })
    if (kind === 'non-atomic action') action.requireSuccess = false
    })
    expect(() => f.boundary.parseRequest(request, f.recipient, { ...f.requests.config, executionGuard: Wallet.createRandom().address }))
      .toThrow(/bound|withdrawal|Invalid private transaction or nullifier/i)
  },
)

it('rejects removal, reordering, recipient tampering or nonce changes under the original full-batch signature', async () => {
  const f = await fixture()
  const request = await f.requests.signedWithdrawalRequest('ab'.repeat(32), 'viewing-key', f.recipient)
  const args = f.boundary.ADAPT.decodeFunctionData('execute', request.data)
  const changedTransfer = f.boundary.ADAPT.encodeFunctionData('transfer', [[{ token: {
    tokenType: 0, tokenAddress: f.config.TOKENS[1].address, tokenSubID: 0 }, to: Wallet.createRandom().address, value: 1000n }]])
  for (const [batch, action, nonce] of [
    [[args[0][0]], args[1], 0n], [[args[0][1], args[0][0]], args[1], 0n],
    [args[0], { requireSuccess: true, minGasLimit: 0n, calls: [{ to: request.to, value: 0n, data: changedTransfer }] }, 0n],
    [args[0], args[1], 1n],
  ]) {
    const data = f.boundary.ADAPT.encodeFunctionData('execute', [batch, action, nonce, args[3]])
    expect(() => f.boundary.parseRequest({ ...request, data }, f.recipient,
      { ...f.requests.config, executionGuard: Wallet.createRandom().address })).toThrow('signature')
  }
})

it('rejects an unbound fee proof even when a valid signer presents the batch as a swap', async () => {
  const f = await fixture()
  const request = await f.requests.signedWithdrawalRequest('ab'.repeat(32), 'viewing-key', f.recipient,
    f.config.TOKENS[1].address, `0x${'11'.repeat(32)}`, (rows, action) => {
      rows[0].boundParams.adaptContract = ZeroAddress
      action.requireSuccess = false
      action.calls = []
    })
  expect(() => f.boundary.parseRequest(request, f.recipient, f.requests.config)).toThrow('Every guarded private proof must be bound')
})

it('keeps the canonical single-proof WBNB withdrawal and rejects a removable fee transaction', async () => {
  const f = await fixture()
  const request = await f.requests.withdrawalRequest('ab'.repeat(32), 'viewing-key', f.recipient, 1, 1, f.config.TOKENS[0].address)
  const parsed = f.boundary.parseRequest(request, f.recipient, f.requests.config)
  expect(parsed.transactions).toHaveLength(1)
  expect(parsed.transactions[0].boundParams.adaptContract).toBe(ZeroAddress)
  expect(parsed.transactions[0].boundParams.adaptParams).toBe(ZeroHash)
  expect(() => f.parse([f.transactions[1]])).toThrow('BNB COMMON withdrawals require one WBNB proof')
})

it.each([1, 137, 42161])('keeps chain %i single-proof COMMON boundary unchanged', async (chainId) => {
  const f = await fixture(chainId)
  expect(f.parse().transactions).toHaveLength(1)
  expect(() => f.parse([f.transactions[0], f.transactions[0]])).toThrow('must share one proof')
  expect(f.config.FEE_TOKENS).toEqual(f.config.TOKENS)
})

it('rejects stablecoin or foreign fee assets even with matching old quotes and forged fresh rates', async () => {
  const f = await fixture()
  const { Store } = await import('../src/storage')
  const { issueFee, validateFee } = await import('../src/fees')
  const directory = mkdtempSync(join(tmpdir(), 'bnb-fee-assets-'))
  const store = new Store(directory)
  try {
    for (const token of [f.config.TOKENS[1].address, f.config.TOKENS[2].address, Wallet.createRandom().address]) {
      const rates = { [token]: 10n ** 18n }, quote = issueFee(store, rates)
      expect(() => validateFee(store, quote.id, { [token]: 1_000n }, 1_000n, rates)).toThrow('does not cover')
    }
    const wrapped = f.config.FEE_TOKENS[0].address
    const rates = { [wrapped]: 1_150_000_000_000_000_000n }, quote = issueFee(store, rates)
    expect(() => validateFee(store, quote.id, { [wrapped]: 1_150n }, 1_000n, rates)).not.toThrow()
    expect(() => validateFee(store, quote.id, { [wrapped]: 1_149n }, 1_000n, rates)).toThrow('does not cover')
    expect(() => validateFee(store, quote.id, { [wrapped]: 0n }, 1_000n, rates)).toThrow('does not cover')
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
