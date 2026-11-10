import type { DatabaseSync } from 'node:sqlite'
import { getAddress, isHexString } from 'ethers'
import { CHAIN_ID, FEE_LIFETIME_MS, TOKENS, type Settings } from './config'
import { accountingReport } from './operations'
import { object } from './wire'
import { ANON_COLLECTION_BASE_FEE_BPS } from './anon-native-collection'

const amount = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n)
    throw new Error('Owner cost quotes require unsigned integer strings.')
  return BigInt(value)
}

/** Read-only budget arithmetic, never transaction authorization or verified owner-quote provenance. */
export function ownerCostPreflight(db: DatabaseSync, config: Settings, input: unknown,
  context: { unshieldFeeBps: bigint; gatewayFeeBps: bigint; health: Record<string, unknown> }, now = Date.now()) {
  if (!object(input) || !object(input.costs) || input.kind !== 'refund')
    throw new Error('Provide a refund cost plan; general collections require independently reconciled owner history.')
  const identity = db.prepare('SELECT id,scope FROM credit_identity WHERE singleton=1').get()
  const scope = JSON.parse(String(identity?.scope)), health = context.health
  if (![1, 56].includes(CHAIN_ID) || config.chainId !== CHAIN_ID || input.chainId !== CHAIN_ID || scope.chainId !== CHAIN_ID ||
    input.ledgerId !== identity?.id || input.operator !== config.operatorAddress || scope.operator !== config.operatorAddress ||
    scope.token !== TOKENS[0].address || input.token !== scope.token)
    throw new Error('Owner cost plan does not match the credit ledger and chain.')
  if (!Number.isSafeInteger(input.expiresAt) || Number(input.expiresAt) <= now || Number(input.expiresAt) > now + FEE_LIFETIME_MS)
    throw new Error('Owner cost quote has expired or exceeds the quote lifetime.')
  if (health.chainId !== CHAIN_ID || health.operatorAddress !== config.operatorAddress || health.synchronized !== true ||
    !object(health.feeBalances) || !Number.isSafeInteger(health.feeBalancesAt) || Number(health.feeBalancesAt) > now ||
    now - Number(health.feeBalancesAt) >= 45_000)
    throw new Error('A fresh matching private balance sample is required.')
  const privateBalance = amount(health.feeBalances[getAddress(scope.token)])
  const report = accountingReport(db), liability = amount(report.prepaidCredit?.liability)
  if (privateBalance < liability || config.marginBps <= 0n || config.marginBps > 10_000n ||
    config.maxGasPrice <= 0n || config.maxTransactionCost <= 0n || context.unshieldFeeBps < 0n || context.unshieldFeeBps > 5000n ||
    context.gatewayFeeBps !== ANON_COLLECTION_BASE_FEE_BPS)
    throw new Error('Owner cost preflight requires backed credit and valid operator limits.')
  const costs = input.costs, steps = ['payout', 'collection']
  if (Object.keys(costs).length !== steps.length || !steps.every((name) => object(costs[name])))
    throw new Error('Quote the private payout and direct native collection exactly once.')
  let nativeCost = 0n, privateCost = 0n
  for (const name of steps) {
    const quote = costs[name]
    if (!object(quote)) throw new Error('Invalid owner cost quote.')
    if ('privateFeeWei' in quote) {
      if (!['payout', 'collection'].includes(name) || Object.keys(quote).length !== 1)
        throw new Error('Private fees are complete alternative quotes for payout or collection only.')
      const fee = amount(quote.privateFeeWei)
      if (!fee || fee > config.maxTransactionCost) throw new Error('Private owner quote exceeds its transaction cost cap.')
      privateCost += fee
    } else {
      if (Object.keys(quote).length !== 2) throw new Error('Native owner quotes require gas limit and maximum gas price only.')
      const gas = amount(quote.gasLimit), price = amount(quote.maxFeePerGas)
      if (!gas || !price || price > config.maxGasPrice || gas * price > config.maxTransactionCost)
        throw new Error('Native owner quote exceeds its gas-price or transaction cost cap.')
      nativeCost += gas * price
    }
  }
  if (typeof input.refundKey !== 'string' || !isHexString(input.refundKey, 32)) throw new Error('Select a saved refund.')
  const saved = db.prepare('SELECT gross,net,recipient,transaction_hash FROM credit_refunds WHERE key=?').get(input.refundKey.toLowerCase())
  const candidate = db.prepare(`SELECT 1 FROM credit_refund_payouts p WHERE refund_key=?
    AND NOT EXISTS(SELECT 1 FROM credit_owner_rejections r WHERE r.transaction_hash=p.transaction_hash
      AND r.block_number=p.block_number AND r.block_hash=p.block_hash)
    AND NOT EXISTS(SELECT 1 FROM credit_owner_unrelated_rejections r WHERE r.transaction_hash=p.transaction_hash
      AND r.block_number=p.block_number AND r.block_hash=p.block_hash)`).get(input.refundKey.toLowerCase())
  if (!saved || saved.transaction_hash !== null || candidate)
    throw new Error('Refund is settled or already has a payout candidate; reconcile it before quoting another payout.')
  const payout = amount(saved.net), budget = amount(saved.gross) - payout
  if (budget <= 0n || payout + budget > privateBalance || budget < privateCost)
    throw new Error('Owner costs exceed the available retained fee.')
  // Treat private fees conservatively as additional costs before unshield gross-up and margin.
  const nativeFraction = (10_000n - context.unshieldFeeBps) * (10_000n - context.gatewayFeeBps)
  const requiredGross = ((nativeCost + privateCost) * (10_000n + config.marginBps) * 10_000n +
    nativeFraction - 1n) / nativeFraction
  const afterLiability = liability - payout - budget
  if (afterLiability < 0n || privateBalance - payout - budget < afterLiability)
    throw new Error('The proposed owner operation would consume customer backing.')
  return { kind: input.kind, chainId: CHAIN_ID, ledgerId: identity!.id, token: scope.token, expiresAt: input.expiresAt,
    refundKey: input.refundKey.toLowerCase(), recipient: saved.recipient, exactNetAmountWei: payout.toString(),
    withinBudget: budget >= requiredGross, availableGrossFeeWei: budget.toString(), requiredGrossFeeWei: requiredGross.toString(),
    shortfallWei: (requiredGross > budget ? requiredGross - budget : 0n).toString(), nativeMaxCostWei: nativeCost.toString(),
    privateMaxCostWei: privateCost.toString(),
    grossCollectionAfterPrivateFeesWei: (budget - privateCost).toString(), privateLiabilityAfterWei: afterLiability.toString(),
    marginBps: config.marginBps.toString(), unshieldFeeBps: context.unshieldFeeBps.toString(), gatewayFeeBps: context.gatewayFeeBps.toString(),
    budgetEstimateOnly: true, ownerQuotesVerified: false, fundsTransferred: false }
}
