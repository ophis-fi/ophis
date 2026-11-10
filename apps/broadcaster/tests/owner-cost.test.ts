import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { id } from 'ethers'
import { Store } from '../src/storage'
import { CreditLedger } from '../src/credit'
import { cliBacking } from './main-sdk.fixture'
import type { CreditBacking } from '../src/credit-backing'
import { ownerCostPreflight } from '../src/owner-cost'
import { CHAIN_ID, TOKENS, settings } from '../src/config'

const recipient = '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
const operator = '0x0000000000000000000000000000000000001234', owner = '0x0000000000000000000000000000000000005678'
const price = 100n, now = Date.now(), deposit = 10n ** 18n, refundGross = deposit / 2n, key = id('refund-only-cost')
const config = settings({ OPHIS_BROADCASTER_CHAIN_ID: String(CHAIN_ID), OPHIS_BROADCASTER_MODE: 'fork',
  OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:8545', OPHIS_BROADCASTER_OPERATOR_ADDRESS: operator,
  OPHIS_BROADCASTER_MARGIN_BPS: '1500', OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: price.toString(),
  OPHIS_BROADCASTER_MAX_TX_COST_WEI: '250000000' })
let root: string, store: Store, ledger: CreditLedger, backing: CreditBacking
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'owner-cost-')); store = new Store(root)
  ledger = new CreditLedger(store, { chainId: CHAIN_ID, operator, recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', token: TOKENS[0].address })
  ledger.deposit({ owner, amount: deposit, tree: 0, position: 0, commitment: id('note'), transactionHash: id('deposit'),
    blockHash: id('canonical'), blockNumber: 10 })
  backing = await cliBacking(ledger.accountedNotes())
})
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })

function scenario(gasAllowance = 2_000_000n) {
  const nativeFraction = 9975n * 9987n
  const retained = (gasAllowance * price * 11_500n * 10_000n + nativeFraction - 1n) / nativeFraction
  ledger.reserveRefund(key, owner, recipient, refundGross, refundGross - retained, ledger.nextSequence(owner), backing, 1n)
  const plan: any = { kind: 'refund', chainId: CHAIN_ID, operator, ledgerId: ledger.id, token: TOKENS[0].address,
    refundKey: key, expiresAt: now + 60_000, costs: Object.fromEntries(Object.entries({
      payout: '1030000', collection: '1110000',
    }).map(([step, gasLimit]) => [step, { gasLimit, maxFeePerGas: price.toString() }])) }
  const context = { unshieldFeeBps: 25n, gatewayFeeBps: 13n, health: { chainId: CHAIN_ID, operatorAddress: operator,
    synchronized: true, feeBalancesAt: now, feeBalances: { [TOKENS[0].address]: deposit.toString() } } }
  return { plan, context, retained, run: () => ownerCostPreflight(store.db, config, plan, context, now) }
}

it('rejects the 2M refund-only budget for a 2.14M-gas payout and native collection without spending or changing the hold', () => {
  const test = scenario(), before = ledger.refund(key), result = test.run()
  expect(result.withinBudget).toBe(false)
  expect(result.nativeMaxCostWei).toBe((2_140_000n * price).toString())
  expect(BigInt(result.requiredGrossFeeWei)).toBeGreaterThan(test.retained)
  expect(result).toMatchObject({ fundsTransferred: false, budgetEstimateOnly: true, ownerQuotesVerified: false })
  expect(ledger.refund(key)).toEqual(before)
  expect(ledger.refundPayouts(key)).toEqual([])
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM credit_attempts').get()!.count).toBe(0)
})

it('accepts a sufficient isolated refund budget while preserving the exact customer payout and remaining liability', () => {
  const test = scenario(3_000_000n), before = ledger.refund(key), result = test.run()
  expect(result.withinBudget).toBe(true)
  expect(result.shortfallWei).toBe('0')
  expect(result.privateLiabilityAfterWei).toBe((deposit - refundGross).toString())
  expect(ledger.refund(key)).toEqual(before)
  expect(config.creditCollectionGas).toBe(0n)
})

it('includes a complete ANON private payout fee instead of pretending that payout uses no fee', () => {
  const test = scenario(3_000_000n)
  test.plan.costs.payout = { privateFeeWei: '120000000' }
  const result = test.run()
  expect(result.withinBudget).toBe(true)
  expect(result.privateMaxCostWei).toBe('120000000')
  expect(result.nativeMaxCostWei).toBe((1_110_000n * price).toString())
  expect(result.grossCollectionAfterPrivateFeesWei).toBe((test.retained - 120000000n).toString())
})

it.each(['no-pool-nullifiers', 'no-fee-wallet-nullifiers'])('can recheck a refund budget after its canonical candidate was rejected: %s', (reason) => {
  const test = scenario(3_000_000n), tx = id(`rejected-${reason}`), blockHash = id('rejected-canonical-block')
  ledger.prepareOwnerOperation({ kind: 'refund', refundKey: key, maximumPrivateFee: 1n, minimumNative: 0n,
    inputLimit: 2, outputLimit: 4, proofLimit: 2, marginBps: 1500n }, backing)
  const intent = ledger.pendingOwnerIntent()!
  // Read-only accounting fixture: the opaque proof/immutable rejection creation is exercised by credit-owner.test.
  store.db.prepare('INSERT INTO credit_refund_payouts(refund_key,transaction_hash,block_number,block_hash,created) VALUES(?,?,?,?,?)')
    .run(key, tx, 20, blockHash, now)
  expect(test.run).toThrow('payout candidate')
  const table = reason === 'no-pool-nullifiers' ? 'credit_owner_rejections' : 'credit_owner_unrelated_rejections'
  store.db.prepare(`INSERT INTO ${table}(transaction_hash,intent_key,block_number,block_hash,reason) VALUES(?,?,?,?,?)`)
    .run(tx, intent.key, 20, blockHash, reason)
  expect(test.run()).toMatchObject({ withinBudget: true, fundsTransferred: false, ownerQuotesVerified: false })
  expect(ledger.pendingOwnerIntent()?.key).toBe(intent.key)
  expect(ledger.refundPayouts(key)).toHaveLength(1)
  store.db.prepare('INSERT INTO credit_refund_payouts(refund_key,transaction_hash,block_number,block_hash,created) VALUES(?,?,?,?,?)')
    .run(key, id('another-unresolved-candidate'), 20, blockHash, now)
  expect(test.run).toThrow('payout candidate')
})

it('covers the compounded pool and gateway deductions at the full approved native cost', () => {
  const test = scenario(2_140_000n), result = test.run()
  const gross = BigInt(result.requiredGrossFeeWei), cost = BigInt(result.nativeMaxCostWei)
  const poolNet = gross - gross * 25n / 10_000n
  const native = poolNet - poolNet * 13n / 10_000n
  expect(result.withinBudget).toBe(true)
  expect(result.gatewayFeeBps).toBe('13')
  expect(native).toBeGreaterThanOrEqual((cost * 11_500n + 9999n) / 10_000n)
  const oldGross = (cost * 11_500n + 9974n) / 9975n
  const oldPoolNet = oldGross - oldGross * 25n / 10_000n
  expect(oldPoolNet - oldPoolNet * 13n / 10_000n).toBeLessThan((cost * 11_500n + 9999n) / 10_000n)
})

it.each(['missing-step', 'extra-step', 'negative', 'number', 'overflow', 'gas-price', 'gas-cost', 'zero-gas', 'mixed-private-native',
  'expired', 'long-expiry', 'wrong-chain', 'wrong-ledger', 'wrong-operator', 'wrong-token', 'stale-balance', 'future-balance',
  'wrong-balance-chain', 'insufficient-backing', 'settled', 'payout-candidate', 'general-collection', 'unsupported-gateway-fee'])(
  'refuses unsafe owner cost input: %s', (failure) => {
    const test = scenario(3_000_000n), { plan, context } = test
    if (failure === 'missing-step') delete plan.costs.collection
    if (failure === 'extra-step') plan.costs.unwrap = plan.costs.collection
    if (failure === 'negative') plan.costs.payout.gasLimit = '-1'
    if (failure === 'number') plan.costs.payout.gasLimit = 1000000
    if (failure === 'overflow') plan.costs.payout.gasLimit = (2n ** 256n).toString()
    if (failure === 'gas-price') plan.costs.payout.maxFeePerGas = (price + 1n).toString()
    if (failure === 'gas-cost') plan.costs.payout.gasLimit = '2500001'
    if (failure === 'zero-gas') plan.costs.payout.gasLimit = '0'
    if (failure === 'mixed-private-native') plan.costs.payout.privateFeeWei = '1'
    if (failure === 'expired') plan.expiresAt = now
    if (failure === 'long-expiry') plan.expiresAt = now + 600_000
    if (failure === 'wrong-chain') plan.chainId = CHAIN_ID === 1 ? 56 : 1
    if (failure === 'wrong-ledger') plan.ledgerId = id('other')
    if (failure === 'wrong-operator') plan.operator = owner
    if (failure === 'wrong-token') plan.token = owner
    if (failure === 'stale-balance') context.health.feeBalancesAt = now - 45_000
    if (failure === 'future-balance') context.health.feeBalancesAt = now + 1
    if (failure === 'wrong-balance-chain') context.health.chainId = CHAIN_ID === 1 ? 56 : 1
    if (failure === 'insufficient-backing') context.health.feeBalances[TOKENS[0].address] = (deposit - 1n).toString()
    if (failure === 'settled') store.db.prepare('UPDATE credit_refunds SET transaction_hash=? WHERE key=?').run(id('paid'), key)
    if (failure === 'payout-candidate') store.db.prepare('INSERT INTO credit_refund_payouts(refund_key,transaction_hash,block_number,block_hash,created) VALUES(?,?,?,?,?)')
      .run(key, id('candidate'), 10, id('canonical'), now)
    if (failure === 'general-collection') plan.kind = 'collection'
    if (failure === 'unsupported-gateway-fee') context.gatewayFeeBps = 14n
    expect(test.run).toThrow()
  },
)
