import { JsonRpcProvider, Transaction } from 'ethers'
import type { ProtectedEthereumProvider } from '../../railgun/operator/protected-provider'
import { MAX_GAS, type Settings } from './config'
import { Store } from './storage'
import { ADAPT, PROXY, assertPrivateExecution, assertTraceSuccess, uint } from './transaction'
import { decodeGuardedExecution } from '../../railgun/operator/execution-guard'
import { signApprovedTransaction, type GasSigner } from './signer'

type Sender = Pick<ProtectedEthereumProvider, 'stageSigned' | 'pendingTransaction' | 'retryPending' | 'cancelPending'>

/** Run with the service stopped and the operator lock held; never prepares a second user proof. */
export async function recover(command: 'retry' | 'cancel', args: string[], config: Settings, store: Store,
  provider: JsonRpcProvider, wallet: GasSigner, sender: Sender): Promise<string> {
  const rows = store.db.prepare('SELECT key FROM requests WHERE confirmed=0').all() as { key: string }[]
  if (rows.length !== 1) throw new Error('Recovery requires exactly one unresolved request.')
  const item = store.get(rows[0].key)!
  if (command === 'retry' && config.mode === 'mainnet' && !item.cancel_raw)
    throw new Error('Unsecured mainnet sponsorship retries are blocked; cancel or reconcile the original transaction.')
  if (!item.raw || !item.hash) throw new Error('The signed recovery record is incomplete.')
  const original = Transaction.from(item.raw)
  if (original.hash !== item.hash || original.from !== wallet.address || original.nonce !== item.nonce || original.chainId !== 1n)
    throw new Error('The signed recovery record is inconsistent.')
  const pending = sender.pendingTransaction()
  const block = await provider.getBlock('latest')
  if (!block || block.baseFeePerGas == null || Math.abs(Date.now() / 1000 - block.timestamp) > 45)
    throw new Error('The recovery read node is stale.')
  const [nonce, confirmed, balance] = await Promise.all([
    provider.getTransactionCount(wallet.address, block.number),
    provider.getTransactionCount(wallet.address, Math.max(0, block.number - 1)),
    provider.getBalance(wallet.address, block.number),
  ])
  if (nonce !== item.nonce || confirmed !== item.nonce) throw new Error('Reconcile the mined operator nonce before recovery.')
  if (pending && (pending.hash !== item.hash || pending.nonce !== item.nonce) && pending.nonce >= confirmed)
    throw new Error('The two recovery journals disagree; preserve both for reconciliation.')
  let raw = item.cancel_raw ?? item.raw
  if (command === 'cancel') {
    if (args.length !== 2) throw new Error('Cancel requires explicit maximum and priority gas prices in wei.')
    const maxFeePerGas = uint(args[0], true), maxPriorityFeePerGas = uint(args[1], true)
    const previous = Transaction.from(raw)
    if (maxFeePerGas <= (previous.maxFeePerGas ?? previous.gasPrice ?? 0n) ||
      maxPriorityFeePerGas <= (previous.maxPriorityFeePerGas ?? previous.gasPrice ?? 0n))
      throw new Error('Cancellation gas prices must exceed both existing signed prices.')
    const transaction = { to: wallet.address, value: 0n, data: '0x', gasLimit: 21_000n,
      type: 2, chainId: 1n, nonce, maxFeePerGas, maxPriorityFeePerGas }
    checkLimits(transaction.gasLimit, maxFeePerGas, maxPriorityFeePerGas, block.baseFeePerGas, balance, config)
    const cost = transaction.gasLimit * maxFeePerGas
    const extra = cost > BigInt(item.max_cost) ? cost - BigInt(item.max_cost) : 0n
    if (store.exposure() + extra > config.dailyBudget) throw new Error('Cancellation exceeds the rolling gas budget.')
    raw = await signApprovedTransaction(wallet, transaction)
    store.cancel(item.key, raw, Transaction.from(raw).hash!, cost, config.dailyBudget)
  } else {
    if (args.length) throw new Error('Retry accepts no replacement parameters.')
    if (!item.cancel_raw && item.fee_expiration <= Date.now())
      throw new Error('The original fee quote expired; cancel the outer gas nonce or reconcile it.')
    const tx = Transaction.from(raw)
    checkLimits(tx.gasLimit, tx.maxFeePerGas ?? tx.gasPrice ?? 0n, tx.maxPriorityFeePerGas ?? 1n,
      block.baseFeePerGas, balance, config)
    if (store.exposure() > config.dailyBudget) throw new Error('The rolling gas budget is exhausted.')
    const trace: unknown = await provider.send('debug_traceCall', [provider.getRpcTransaction({
      to: tx.to, data: tx.data, value: tx.value, from: wallet.address, type: tx.type,
      nonce: tx.nonce, chainId: tx.chainId, gasLimit: tx.gasLimit, gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      authorizationList: tx.authorizationList,
    }), `0x${block.number.toString(16)}`, { tracer: 'callTracer', timeout: '10s' }])
    if (item.cancel_raw) assertTraceSuccess(trace)
    else assertPrivateExecution(trace, original.type === 4 ? PROXY.encodeFunctionData('transact', [
      ADAPT.decodeFunctionData('execute', config.executionGuard
        ? decodeGuardedExecution(original.data).execution : original.data)._transactions,
    ]) : original.data)
  }
  // The transport can still retain the previous confirmed nonce after a crash before staging this one.
  if (!pending || pending.hash !== item.hash) await sender.stageSigned(item.raw)
  if (command === 'cancel' || item.cancel_raw) return sender.cancelPending(raw)
  return sender.retryPending()
}

function checkLimits(gas: bigint, price: bigint, tip: bigint, base: bigint, balance: bigint, config: Settings): void {
  if (gas <= 0n || gas > MAX_GAS || tip <= 0n || tip > price || price < base + tip ||
    price > config.maxGasPrice || gas * price > config.maxTransactionCost ||
    balance < gas * price + config.reserve || !config.dailyBudget)
    throw new Error('Recovery exceeds the explicit gas, balance or price limits.')
}
