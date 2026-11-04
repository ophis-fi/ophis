import { statfsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { getAddress, JsonRpcProvider, Transaction } from 'ethers'
import { TOKENS, type Settings } from './config'
import type { FeeOracle } from './fees'
import type { Store } from './storage'

export function accountingReport(db: DatabaseSync): {
  requests: number; recordedGasExpenseWei: string; unresolvedMaximumWei: string
  acknowledgedLossWei: string; acknowledgedLosses: number; historicalSettlementsWithoutFeeAmounts: number
  receivedFees: Record<string, string>
} {
  const records = db.prepare('SELECT key,hash,confirmed,assured,max_cost,actual_cost,fee_data FROM requests').all()
  const resolutions = db.prepare('SELECT key,hash,actual_cost FROM settlement_resolutions').all()
  const resolved = new Map(resolutions.map((row) => [row.key, row]))
  const fees: Record<string, bigint> = {}
  let gas = 0n, unresolved = 0n, losses = 0n, historical = 0, lossCount = 0
  for (const row of records) {
    const expense = row.actual_cost == null ? 0n : BigInt(String(row.actual_cost))
    gas += expense
    const resolution = resolved.get(row.key)
    const acknowledged = row.confirmed === 1 && row.assured === 0 && resolution?.hash === row.hash && resolution?.actual_cost === row.actual_cost
    if (acknowledged) { losses += expense; lossCount++ }
    if (!row.confirmed) unresolved += BigInt(String(row.max_cost))
    else if (!row.assured && !acknowledged) unresolved += expense
    if (!row.assured) continue
    const proof = JSON.parse(String(row.fee_data))
    if (proof.settlement === 'cancelled') continue
    if (proof.settlement !== 'fee-received' || !proof.payment) { historical++; continue }
    const token = getAddress(proof.payment.token)
    if (!TOKENS.some((item) => getAddress(item.address) === token) || typeof proof.payment.amount !== 'string' || !/^[1-9]\d*$/.test(proof.payment.amount))
      throw new Error('Invalid received-fee accounting record.')
    fees[token] = (fees[token] ?? 0n) + BigInt(proof.payment.amount)
  }
  return { requests: records.length, recordedGasExpenseWei: gas.toString(), unresolvedMaximumWei: unresolved.toString(),
    acknowledgedLossWei: losses.toString(), acknowledgedLosses: lossCount, historicalSettlementsWithoutFeeAmounts: historical,
    receivedFees: Object.fromEntries(Object.entries(fees).map(([token, amount]) => [token, amount.toString()])) }
}

/** Exclusive stopped-service lock is held by the CLI; this function never signs or submits. */
export async function acknowledgeLoss(key: string, reason: string, config: Settings, store: Store, provider: JsonRpcProvider): Promise<void> {
  const item = store.get(key)
  if (!item?.raw || !item.hash || item.confirmed !== 1 || item.assured !== 0 || !item.actual_cost ||
    !config.operatorAddress || !/^[\x20-\x7e]{10,200}$/.test(reason))
    throw new Error('Select a confirmed unpaid request and provide a bounded audit reason.')
  const tx = Transaction.from(item.raw)
  if (tx.hash !== item.hash || tx.from !== config.operatorAddress || tx.nonce !== item.nonce || tx.chainId !== 1n)
    throw new Error('The original signed record is inconsistent.')
  const [head, finalized, receipt] = await Promise.all([
    provider.getBlock('latest'), provider.getBlock('finalized'), provider.getTransactionReceipt(item.hash),
  ])
  if ((await provider.getNetwork()).chainId !== 1n || !head || head.baseFeePerGas == null ||
    Math.abs(Date.now() / 1000 - head.timestamp) > 45 || !finalized || !receipt || receipt.status !== 0 ||
    receipt.hash !== item.hash || getAddress(receipt.from) !== config.operatorAddress || receipt.blockNumber > finalized.number ||
    receipt.blobGasUsed || receipt.gasUsed * receipt.gasPrice !== BigInt(item.actual_cost))
    throw new Error('Only an original finalized reverted transaction with verified gas expenditure can be acknowledged.')
  const [block, nonce, code, cancellation] = await Promise.all([
    provider.getBlock(receipt.blockNumber), provider.getTransactionCount(config.operatorAddress, head.number),
    provider.getCode(config.operatorAddress, head.number),
    item.cancel_hash ? provider.getTransactionReceipt(item.cancel_hash) : null,
  ])
  if (!block || block.hash !== receipt.blockHash || nonce !== item.nonce + 1 || code !== '0x' || cancellation)
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
    bounded(localHealth(port)), bounded(provider.getBlock('latest')), bounded(oracle.rates()),
    bounded(config.operatorAddress ? provider.getBalance(config.operatorAddress) : Promise.reject(new Error('Missing operator address'))),
    bounded(provider.send('eth_chainId', [])),
  ])
  const [service, block, rates, balance, network] = checks
  if (service.status === 'fulfilled') {
    health = Object.fromEntries(['ready', 'locked', 'synchronized', 'pending', 'feeAssurancePending', 'errors']
      .map((key) => [key, service.value[key]]))
    if (typeof health.ready !== 'boolean' || typeof health.locked !== 'boolean' || typeof health.synchronized !== 'boolean' ||
      !['pending', 'feeAssurancePending', 'errors'].every((key) => Number.isSafeInteger(health?.[key]) && Number(health?.[key]) >= 0)) alerts.push('invalid-health')
    else {
      if (health.locked) alerts.push('signer-locked')
      if (!health.synchronized) alerts.push('history-incomplete')
      if (!health.ready) alerts.push('service-unavailable')
      if (Number(health.pending)) alerts.push('pending-nonce')
      if (Number(health.feeAssurancePending)) alerts.push('missing-fee-assurance')
      if (Number(health.errors)) alerts.push('service-errors')
    }
  } else alerts.push('health-unreachable')
  if (block.status !== 'fulfilled' || !block.value || block.value.baseFeePerGas == null ||
    Math.abs(Date.now() / 1000 - block.value.timestamp) > 45) alerts.push('stale-read-node')
  else if (block.value.baseFeePerGas + 1n > config.maxGasPrice) alerts.push('gas-price-cap')
  if (rates.status !== 'fulfilled' || !TOKENS.every((token) => rates.value[getAddress(token.address)] > 0n)) alerts.push('stale-fee-pricing')
  if (network.status !== 'fulfilled' || network.value !== '0x1') alerts.push('wrong-read-network')
  if (balance.status === 'fulfilled') {
    gasBalanceWei = balance.value.toString()
    if (balance.value < config.reserve + config.maxTransactionCost) alerts.push('low-gas-reserve')
  } else alerts.push('balance-unavailable')
  return { ok: alerts.length === 0, alerts, gasBalanceWei, health }
}

export function monitorMetrics(result: Awaited<ReturnType<typeof monitor>>): string {
  const lines = [`ophis_broadcaster_monitor_ok ${result.ok ? 1 : 0}`,
    `ophis_broadcaster_last_check_seconds ${Math.floor(Date.now() / 1000)}`]
  for (const reason of result.alerts) {
    if (!/^[a-z-]+$/.test(reason)) throw new Error('Invalid monitor label.')
    lines.push(`ophis_broadcaster_alert{reason="${reason}"} 1`)
  }
  return lines.join('\n') + '\n'
}
