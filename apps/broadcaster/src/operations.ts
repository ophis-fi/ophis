import { statfsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { getAddress, isAddress, JsonRpcProvider, Transaction, ZeroAddress } from 'ethers'
import { CHAIN, CHAIN_ID, FEE_TOKENS, TOKENS, type Settings } from './config'
import { readChainState } from './chain-state'
import type { FeeOracle } from './fees'
import type { Store } from './storage'

export function accountingReport(db: DatabaseSync): {
  requests: number; recordedGasExpenseWei: string; unresolvedMaximumWei: string
  acknowledgedLossWei: string; acknowledgedLosses: number; historicalSettlementsWithoutFeeAmounts: number
  receivedFees: Record<string, string>
  prepaidCredit?: { token: string; deposited: string; charged: string; reserved: string; pendingRefunds: string;
    completedRefunds: string; refundFees: string; liability: string; remainingEarned: string; collectedGross: string;
    ownerPrivateFees: string; nativeCollected: string; ownerPaymentsPending: number;
    funding?: 'native'; quarantined?: string; nativeRefundReservations?: string }
} {
  const records = db.prepare('SELECT key,hash,confirmed,assured,max_cost,actual_cost,fee_data FROM requests').all()
  const resolutions = db.prepare('SELECT key,hash,actual_cost FROM settlement_resolutions').all()
  const resolved = new Map(resolutions.map((row) => [row.key, row]))
  const fees: Record<string, bigint> = {}
  let prepaidCredit: ReturnType<typeof accountingReport>['prepaidCredit']
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_identity'").get()) {
    const identity = db.prepare('SELECT scope FROM credit_identity WHERE singleton=1').get()
    const scope = JSON.parse(String(identity?.scope)), token = getAddress(scope.token)
    const native = scope.funding === 'native'
    if (scope.chainId !== CHAIN_ID || (scope.funding !== undefined && !native) ||
      (native ? token !== ZeroAddress || getAddress(scope.recipient) !== getAddress(scope.operator) : token !== getAddress(TOKENS[0].address)))
      throw new Error('Invalid credit accounting scope.')
    const sum = (sql: string) => db.prepare(sql).all().reduce((total, row) => {
      if (typeof row.amount !== 'string' || !/^(0|[1-9]\d*)$/.test(row.amount)) throw new Error('Invalid credit accounting amount.')
      return total + BigInt(row.amount)
    }, 0n)
    if (native) {
      const quarantined = sum('SELECT amount FROM credit_native_duplicate_deposits')
      const deposited = sum('SELECT amount FROM credit_native_deposits') + quarantined
      const debited = sum('SELECT charged AS amount FROM credit_attempts WHERE charged IS NOT NULL')
      const completedRefunds = sum('SELECT paid AS amount FROM credit_native_refund_settlements')
      const charged = debited - completedRefunds
      const reserved = sum('SELECT maximum_charge AS amount FROM credit_attempts WHERE charged IS NULL')
      const refundFees = sum(`SELECT a.charged AS amount FROM credit_native_refund_settlements s
        JOIN credit_attempts a ON a.key=s.key`) - completedRefunds
      const nativeRefundReservations = sum(`SELECT a.maximum_charge AS amount FROM credit_native_refund_attempts i
        JOIN credit_attempts a ON a.key=i.key WHERE a.charged IS NULL`)
      const gas = sum(`SELECT r.actual_cost AS amount FROM credit_attempts a JOIN requests r ON r.key=a.key WHERE a.charged IS NOT NULL`)
      const liability = deposited - debited, remainingEarned = charged - gas
      if (charged < 0n || refundFees < 0n || remainingEarned < 0n || liability < reserved + quarantined)
        throw new Error('Native credit accounting is inconsistent.')
      // Native refund reservations already belong to reserved; adding them again would double-count the same liability.
      prepaidCredit = { funding: 'native', token, deposited: String(deposited), charged: String(charged), reserved: String(reserved),
        pendingRefunds: '0', completedRefunds: String(completedRefunds), refundFees: String(refundFees), liability: String(liability),
        remainingEarned: String(remainingEarned), collectedGross: '0', ownerPrivateFees: '0', nativeCollected: String(charged),
        ownerPaymentsPending: 0, quarantined: String(quarantined), nativeRefundReservations: String(nativeRefundReservations) }
      fees[token] = charged
    } else {
      const deposited = sum('SELECT amount FROM credit_deposits')
      const charged = sum('SELECT charged AS amount FROM credit_attempts WHERE charged IS NOT NULL')
      const reserved = sum('SELECT maximum_charge AS amount FROM credit_attempts WHERE charged IS NULL')
      const pendingRefunds = sum('SELECT gross AS amount FROM credit_refunds WHERE transaction_hash IS NULL')
      const completedRefunds = sum('SELECT gross AS amount FROM credit_refunds WHERE transaction_hash IS NOT NULL')
      const refundFees = completedRefunds - sum('SELECT net AS amount FROM credit_refunds WHERE transaction_hash IS NOT NULL')
      const liability = deposited - charged - completedRefunds
      const ownerJournal = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_owner_settlements'").get()
      const collectedGross = ownerJournal ? sum('SELECT unshield_gross AS amount FROM credit_owner_settlements') : 0n
      const ownerPrivateFees = ownerJournal ? sum('SELECT private_fee AS amount FROM credit_owner_settlements') : 0n
      const nativeCollected = ownerJournal ? sum('SELECT native_received AS amount FROM credit_owner_settlements') : 0n
      const remainingEarned = charged + refundFees - collectedGross - ownerPrivateFees
      const ownerPaymentsPending = ownerJournal ? Number(db.prepare(`SELECT COUNT(*) AS count FROM credit_owner_intents i
        WHERE NOT EXISTS(SELECT 1 FROM credit_owner_settlements s WHERE s.intent_key=i.key)`).get()?.count) : 0
      if (refundFees < 0n || liability < reserved + pendingRefunds || remainingEarned < 0n) throw new Error('Credit accounting is inconsistent.')
      prepaidCredit = { token, deposited: String(deposited), charged: String(charged), reserved: String(reserved),
        pendingRefunds: String(pendingRefunds), completedRefunds: String(completedRefunds), refundFees: String(refundFees), liability: String(liability),
        remainingEarned: String(remainingEarned), collectedGross: String(collectedGross), ownerPrivateFees: String(ownerPrivateFees),
        nativeCollected: String(nativeCollected), ownerPaymentsPending }
      fees[token] = charged + refundFees
    }
  }
  let gas = 0n, unresolved = 0n, losses = 0n, historical = 0, lossCount = 0
  for (const row of records) {
    const expense = row.actual_cost == null ? 0n : BigInt(String(row.actual_cost))
    gas += expense
    const resolution = resolved.get(row.key)
    const acknowledged = row.confirmed === 1 && row.assured === 0 && resolution?.hash === row.hash && resolution?.actual_cost === row.actual_cost
    if (acknowledged) { losses += expense; lossCount++ }
    if (!row.confirmed || (!row.assured && row.actual_cost == null)) unresolved += BigInt(String(row.max_cost))
    else if (!row.assured && !acknowledged) unresolved += expense
    if (!row.assured) continue
    const proof = JSON.parse(String(row.fee_data))
    if (proof.kind === 'prepaid') {
      const attempt = db.prepare('SELECT charged,settlement_hash FROM credit_attempts WHERE key=?').get(row.key)
      if (!prepaidCredit || !attempt || attempt.charged !== proof.charged || attempt.settlement_hash !== proof.receiptHash)
        throw new Error('Invalid prepaid settlement accounting record.')
      continue
    }
    if (proof.settlement === 'cancelled') continue
    if (proof.settlement !== 'fee-received' || !proof.payment) { historical++; continue }
    const token = getAddress(proof.payment.token)
    if (!TOKENS.some((item) => getAddress(item.address) === token) || typeof proof.payment.amount !== 'string' || !/^[1-9]\d*$/.test(proof.payment.amount))
      throw new Error('Invalid received-fee accounting record.')
    fees[token] = (fees[token] ?? 0n) + BigInt(proof.payment.amount)
  }
  return { requests: records.length, recordedGasExpenseWei: gas.toString(), unresolvedMaximumWei: unresolved.toString(),
    acknowledgedLossWei: losses.toString(), acknowledgedLosses: lossCount, historicalSettlementsWithoutFeeAmounts: historical,
    receivedFees: Object.fromEntries(Object.entries(fees).map(([token, amount]) => [token, amount.toString()])),
    ...(prepaidCredit ? { prepaidCredit } : {}) }
}

/** Exclusive stopped-service lock is held by the CLI; this function never signs or submits. */
export async function acknowledgeLoss(key: string, reason: string, config: Settings, store: Store, provider: JsonRpcProvider): Promise<void> {
  if (config.chainId !== CHAIN_ID) throw new Error('Loss acknowledgment settings must match the broadcaster chain.')
  const item = store.get(key)
  if (!item?.raw || !item.hash || item.confirmed !== 1 || item.assured !== 0 || !item.actual_cost ||
    !config.operatorAddress || !/^[\x20-\x7e]{10,200}$/.test(reason))
    throw new Error('Select a confirmed unpaid request and provide a bounded audit reason.')
  const tx = Transaction.from(item.raw)
  if (tx.hash !== item.hash || tx.from !== config.operatorAddress || tx.nonce !== item.nonce || tx.chainId !== CHAIN)
    throw new Error('The original signed record is inconsistent.')
  const [{ block: head, settled }, finalized, receipt] = await Promise.all([
    readChainState(provider), provider.getBlock('finalized'), provider.getTransactionReceipt(item.hash),
  ])
  // Loss acknowledgment requires finality even where normal Ethereum reconciliation uses head minus one.
  if ((await provider.getNetwork()).chainId !== CHAIN || !finalized || !Number.isSafeInteger(finalized.number) ||
    finalized.number < 0 || finalized.number > head.number || !finalized.hash || !/^0x[0-9a-f]{64}$/i.test(finalized.hash) ||
    /^0x0{64}$/i.test(finalized.hash) || !receipt || receipt.status !== 0 ||
    receipt.hash !== item.hash || getAddress(receipt.from) !== config.operatorAddress || receipt.blockNumber > Math.min(finalized.number, settled) ||
    receipt.blobGasUsed || receipt.gasUsed * receipt.gasPrice !== BigInt(item.actual_cost))
    throw new Error('Only an original finalized reverted transaction with verified gas expenditure can be acknowledged.')
  const [block, nonce, code, cancellation] = await Promise.all([
    provider.getBlock(receipt.blockNumber), provider.getTransactionCount(config.operatorAddress, head.number),
    provider.getCode(config.operatorAddress, head.number),
    Promise.all(store.cancellations(item.key).map((item) => provider.getTransactionReceipt(item.hash))),
  ])
  if (!block || block.hash !== receipt.blockHash || nonce !== item.nonce + 1 || code !== '0x' || cancellation.some(Boolean))
    throw new Error('The canonical block, operator nonce or cancellation is unresolved.')
  store.acknowledgeLoss(key, item.hash, BigInt(item.actual_cost), receipt.blockNumber, receipt.blockHash, reason)
}

export async function localHealth(port: number): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid health port.')
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' })
  const body = await response.text()
  if (!response.ok || body.length > 8192) throw new Error('Local health is unavailable.')
  const health: unknown = JSON.parse(body)
  if (!health || typeof health !== 'object' || Array.isArray(health)) throw new Error('Invalid local health.')
  return health as Record<string, unknown>
}

export async function monitor(config: Settings, provider: JsonRpcProvider, oracle: Pick<FeeOracle, 'rates'>, port: number): Promise<{
  ok: boolean; alerts: string[]; gasBalanceWei?: string; health?: Record<string, unknown>
}> {
  if (config.chainId !== CHAIN_ID) throw new Error('Monitor settings must match the broadcaster chain.')
  const alerts: string[] = []
  let health: Record<string, unknown> | undefined, gasBalanceWei: string | undefined
  const bounded = async <T>(request: Promise<T>): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([request, new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Monitoring read timed out.')), 15_000)
      })])
    } finally { clearTimeout(timeout) }
  }
  try {
    const disk = statfsSync(config.state)
    if (disk.bavail * disk.bsize < 6 * 1024 ** 3) alerts.push('low-disk')
  } catch { alerts.push('storage-unavailable') }
  const checks = await Promise.allSettled([
    bounded(localHealth(port)), bounded(readChainState(provider)), bounded(oracle.rates()),
    bounded(config.operatorAddress ? provider.getBalance(config.operatorAddress) : Promise.reject(new Error('Missing operator address'))),
    bounded(provider.send('eth_chainId', [])),
  ])
  const [service, block, rates, balance, network] = checks
  if (service.status === 'fulfilled') {
    const sample = service.value
    if (!Number.isSafeInteger(sample.chainId) || typeof sample.operatorAddress !== 'string' || !isAddress(sample.operatorAddress) ||
      typeof sample.ready !== 'boolean' || typeof sample.locked !== 'boolean' || typeof sample.synchronized !== 'boolean' ||
      typeof sample.wakuSaturated !== 'boolean' ||
      !['pending', 'feeAssurancePending', 'errors'].every((key) => Number.isSafeInteger(sample[key]) && Number(sample[key]) >= 0)) alerts.push('invalid-health')
    else if (sample.chainId !== CHAIN_ID || !config.operatorAddress || getAddress(sample.operatorAddress) !== getAddress(config.operatorAddress))
      alerts.push('wrong-service-instance')
    else {
      health = Object.fromEntries(['chainId', 'operatorAddress', 'ready', 'locked', 'synchronized', 'pending', 'feeAssurancePending', 'errors', 'wakuSaturated']
        .map((key) => [key, sample[key]]))
      if (health.locked) alerts.push('signer-locked')
      if (!health.synchronized) alerts.push('history-incomplete')
      if (!health.ready) alerts.push('service-unavailable')
      if (Number(health.pending)) alerts.push('pending-nonce')
      if (Number(health.feeAssurancePending)) alerts.push('missing-fee-assurance')
      if (Number(health.errors)) alerts.push('service-errors')
      if (health.wakuSaturated) alerts.push('waku-saturated')
    }
  } else alerts.push('health-unreachable')
  if (block.status !== 'fulfilled') alerts.push('stale-read-node')
  else if (block.value.baseFee + 1n > config.maxGasPrice || block.value.minimumGasPrice > config.maxGasPrice) alerts.push('gas-price-cap')
  if (rates.status !== 'fulfilled' || !FEE_TOKENS.every((token) => rates.value[getAddress(token.address)] > 0n)) alerts.push('stale-fee-pricing')
  if (network.status !== 'fulfilled' || network.value !== `0x${CHAIN.toString(16)}`) alerts.push('wrong-read-network')
  if (balance.status === 'fulfilled') {
    gasBalanceWei = balance.value.toString()
    if (balance.value < config.reserve + config.maxTransactionCost) alerts.push('low-gas-reserve')
  } else alerts.push('balance-unavailable')
  return { ok: alerts.length === 0, alerts, gasBalanceWei, health }
}

export function monitorMetrics(result: Awaited<ReturnType<typeof monitor>>): string {
  const labels = `chain_id="${CHAIN_ID}"`
  const lines = [`ophis_broadcaster_monitor_ok{${labels}} ${result.ok ? 1 : 0}`,
    `ophis_broadcaster_last_check_seconds{${labels}} ${Math.floor(Date.now() / 1000)}`]
  for (const reason of result.alerts) {
    if (!/^[a-z-]+$/.test(reason)) throw new Error('Invalid monitor label.')
    lines.push(`ophis_broadcaster_alert{${labels},reason="${reason}"} 1`)
  }
  return lines.join('\n') + '\n'
}
