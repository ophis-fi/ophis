import { JsonRpcProvider, Transaction } from 'ethers'
import type { ProtectedEthereumProvider } from '../../railgun/operator/protected-provider'
import { assertSigningNetwork, CHAIN, CHAIN_ID, MAX_GAS, type Settings } from './config'
import { readChainState } from './chain-state'
import { Store, type RequestRecord } from './storage'
import { ADAPT, PROXY, assertPrivateExecution, assertTraceSuccess, uint } from './transaction'
import { decodeGuardedExecution } from '../../railgun/operator/execution-guard'
import { signApprovedTransaction, type GasSigner } from './signer'
import { CreditLedger } from './credit'
import { assertNativeRefundTrace, verifyNativeBacking } from './credit-native-payment'

type Sender = Pick<ProtectedEthereumProvider, 'stageSigned' | 'stageRecovery' | 'pendingTransaction' | 'retryPending' | 'cancelPending'>

/** Run with the service stopped and the operator lock held; never prepares a second user proof. */
export async function recover(command: 'retry' | 'cancel', args: string[], config: Settings, store: Store,
  provider: JsonRpcProvider, wallet: GasSigner, sender: Sender): Promise<string> {
  assertSigningNetwork(config)
  if (config.chainId !== CHAIN_ID) throw new Error('Recovery settings do not match the process chain.')
  if (command === 'retry' && args.length) throw new Error('Retry accepts no replacement parameters.')
  if (command === 'cancel' && args.length !== 2) throw new Error('Cancel requires explicit maximum and priority gas prices in wei.')
  // A backup cannot establish whether newer signatures, credit charges or refunds existed.
  // It remains blocked until complete newer journals are recovered; nonce equality is not enough.
  store.assertCreditJournalActive()
  const rows = store.db.prepare('SELECT * FROM requests WHERE confirmed=0 ORDER BY nonce,key').all() as unknown as RequestRecord[]
  if (!rows.length) throw new Error('Recovery requires an unresolved request.')
  let item = rows[0]
  const prepaid = JSON.parse(item.fee_data).kind === 'prepaid'
  let nativeLedger: CreditLedger | undefined
  const verifyNative = async () => {
    if (nativeLedger) nativeLedger.assertNativeBacked(await verifyNativeBacking(provider, nativeLedger.scope, nativeLedger.id,
      nativeLedger.nativeDeposits(), nativeLedger.nativeSettlements()), config.reserve, item.nonce)
  }
  if (rows.length > 1) {
    if (!prepaid) throw new Error('Multiple unresolved operations require complete prepaid journals.')
    assertHeldRange(store, CreditLedger.load(store), item.nonce, rows[rows.length - 1].nonce, wallet.address)
  }
  if (prepaid) {
    const ledger = CreditLedger.load(store)
    if (ledger.isNative) nativeLedger = ledger
    if (ledger.scope.chainId !== CHAIN_ID || ledger.scope.operator !== wallet.address || (await provider.getNetwork()).chainId !== CHAIN)
      throw new Error('Prepaid recovery belongs to another chain or operator.')
    ledger.assertChainNonce(await provider.getTransactionCount(wallet.address, 'latest'))
    if (!item.raw && !item.hash) {
      const held = ledger.attempt(item.key)
      if (!held || held.charged !== null || (command === 'retry' && item.fee_expiration <= Date.now()))
        throw new Error('The reserved request cannot be retried. Cancel its held nonce after quote expiry.')
      const tx = Transaction.from(held.unsigned)
      const state = await readChainState(provider)
      const [latest, settled, balance] = await Promise.all([
        provider.getTransactionCount(wallet.address, state.block.number), provider.getTransactionCount(wallet.address, state.settled),
        provider.getBalance(wallet.address, state.block.number),
      ])
      if (latest !== item.nonce || settled !== item.nonce || balance < BigInt(item.max_cost) + config.reserve || store.exposure() > config.dailyBudget)
        throw new Error('Reconcile the reserved nonce and operator budget before recovery.')
      if (command === 'cancel') {
        const price = uint(args[0], true), tip = uint(args[1], true)
        if (price <= (tx.maxFeePerGas ?? tx.gasPrice ?? 0n) || tip <= (tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n))
          throw new Error('Cancellation gas prices must exceed both existing signed prices.')
        const estimate = CHAIN_ID === 1 ? 21_000n : await provider.estimateGas({ to: wallet.address, from: wallet.address,
          value: 0n, data: '0x', type: 2, chainId: CHAIN, nonce: item.nonce, maxFeePerGas: price, maxPriorityFeePerGas: tip })
        const gas = CHAIN_ID === 1 ? estimate : (estimate * 110n + 99n) / 100n
        checkLimits(gas, price, tip, state.baseFee, state.minimumGasPrice, balance, config)
        store.assertPrepaidCancellationCovered(item.key, gas * price)
      } else checkLimits(tx.gasLimit, tx.maxFeePerGas ?? tx.gasPrice ?? 0n,
        tx.type === 2 || tx.type === 4 ? tx.maxPriorityFeePerGas ?? 0n : undefined,
        state.baseFee, state.minimumGasPrice, balance - tx.value, config)
      // Recreate only the exact already-funded outer signature; cancellation never publishes this original.
      await verifyNative()
      const raw = await signApprovedTransaction(wallet, tx.toJSON())
      ledger.attachSignature(item.key, raw)
      item = store.get(item.key)!
    }
  }
  if (command === 'retry' && config.mode === 'mainnet' && !item.cancel_raw && !prepaid)
    throw new Error('Unsecured mainnet sponsorship retries are blocked; cancel or reconcile the original transaction.')
  if (!item.raw || !item.hash) throw new Error('The signed recovery record is incomplete.')
  const original = Transaction.from(item.raw)
  if (original.hash !== item.hash || original.from !== wallet.address || original.nonce !== item.nonce || original.chainId !== CHAIN)
    throw new Error('The signed recovery record is inconsistent.')
  if ((await provider.getNetwork()).chainId !== CHAIN) throw new Error('The recovery read node is on another chain.')
  const pending = sender.pendingTransaction()
  const { block, settled, baseFee, minimumGasPrice } = await readChainState(provider)
  const [nonce, confirmed, balance] = await Promise.all([
    provider.getTransactionCount(wallet.address, block.number),
    provider.getTransactionCount(wallet.address, settled),
    provider.getBalance(wallet.address, block.number),
  ])
  if (nonce !== item.nonce || confirmed !== item.nonce) throw new Error('Reconcile the mined operator nonce before recovery.')
  let rewind: typeof pending
  if (pending && (pending.hash !== item.hash || pending.nonce !== item.nonce) && pending.nonce >= confirmed) {
    if (!prepaid || pending.nonce <= item.nonce)
      throw new Error('The two recovery journals disagree; preserve both for reconciliation.')
    const held = assertHeldRange(store, CreditLedger.load(store), item.nonce, pending.nonce, wallet.address)
    const displaced = held[held.length - 1]
    if (displaced.hash !== pending.hash || (pending.cancellationHash &&
      !store.cancellations(displaced.key).some((tx) => tx.hash === pending.cancellationHash)))
      throw new Error('The displaced protected operation is missing from the complete request journal.')
    rewind = pending
  }
  if (pending?.hash === item.hash && pending.cancellationHash &&
    !store.cancellations(item.key).some((tx) => tx.hash === pending.cancellationHash))
    throw new Error('The protected cancellation is missing from the request journal.')
  let raw = item.cancel_raw ?? item.raw
  const tx = Transaction.from(raw)
  if (tx.from !== wallet.address || tx.chainId !== CHAIN || tx.nonce !== item.nonce ||
    (item.cancel_raw && tx.hash !== item.cancel_hash))
    throw new Error('The signed recovery cancellation record is inconsistent.')
  if (command === 'cancel') {
    if (args.length !== 2) throw new Error('Cancel requires explicit maximum and priority gas prices in wei.')
    const maxFeePerGas = uint(args[0], true), maxPriorityFeePerGas = uint(args[1], true)
    if (maxFeePerGas <= (tx.maxFeePerGas ?? tx.gasPrice ?? 0n) ||
      maxPriorityFeePerGas <= (tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n))
      throw new Error('Cancellation gas prices must exceed both existing signed prices.')
    const cancellation = { to: wallet.address, value: 0n, data: '0x',
      type: 2, chainId: CHAIN, nonce, maxFeePerGas, maxPriorityFeePerGas }
    const estimate = CHAIN_ID === 1 ? 21_000n : await provider.estimateGas({ ...cancellation, from: wallet.address })
    if (typeof estimate !== 'bigint' || estimate < 21_000n) throw new Error('Invalid cancellation gas estimate.')
    const gasLimit = CHAIN_ID === 1 ? estimate : (estimate * 110n + 99n) / 100n
    const transaction = { ...cancellation, gasLimit }
    checkLimits(gasLimit, maxFeePerGas, maxPriorityFeePerGas, baseFee, minimumGasPrice, balance, config)
    const cost = gasLimit * maxFeePerGas
    store.assertPrepaidCancellationCovered(item.key, cost)
    const extra = cost > BigInt(item.max_cost) ? cost - BigInt(item.max_cost) : 0n
    if (store.exposure() + extra > config.dailyBudget) throw new Error('Cancellation exceeds the rolling gas budget.')
    await verifyNative()
    raw = await signApprovedTransaction(wallet, transaction)
    store.cancel(item.key, raw, Transaction.from(raw).hash!, cost, config.dailyBudget)
  } else {
    if (args.length) throw new Error('Retry accepts no replacement parameters.')
    if (!item.cancel_raw && item.fee_expiration <= Date.now())
      throw new Error('The original fee quote expired; cancel the outer gas nonce or reconcile it.')
    checkLimits(tx.gasLimit, tx.maxFeePerGas ?? tx.gasPrice ?? 0n,
      tx.type === 2 || tx.type === 4 ? tx.maxPriorityFeePerGas ?? 0n : undefined,
      baseFee, minimumGasPrice, balance - tx.value, config)
    if (store.exposure() > config.dailyBudget) throw new Error('The rolling gas budget is exhausted.')
    const trace: unknown = await provider.send('debug_traceCall', [provider.getRpcTransaction({
      to: tx.to, data: tx.data, value: tx.value, from: wallet.address, type: tx.type,
      nonce: tx.nonce, chainId: tx.chainId, gasLimit: tx.gasLimit, gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      authorizationList: tx.authorizationList,
    }), `0x${block.number.toString(16)}`, { tracer: 'callTracer', timeout: '10s' }])
    if (item.cancel_raw) assertTraceSuccess(trace)
    else if (nativeLedger?.nativeRefund(item.key)) assertNativeRefundTrace(trace, { from: wallet.address, to: tx.to!, value: tx.value })
    else assertPrivateExecution(trace, original.type === 4 ? PROXY.encodeFunctionData('transact', [
      ADAPT.decodeFunctionData('execute', config.executionGuard
        ? decodeGuardedExecution(original.data).execution : original.data)._transactions,
    ]) : original.data)
  }
  // Recheck native liabilities/origins after simulation and before any saved signature is disclosed.
  await verifyNative()
  // The transport can still retain the previous confirmed nonce after a crash before staging this one.
  if (rewind) await sender.stageRecovery(item.raw, rewind)
  else if (!pending || pending.hash !== item.hash) await sender.stageSigned(item.raw)
  const staged = sender.pendingTransaction()
  if (staged?.hash === item.hash && staged.cancellationHash &&
    !store.cancellations(item.key).some((tx) => tx.hash === staged.cancellationHash))
    throw new Error('The restored protected cancellation is missing from the request journal.')
  if (command === 'cancel' || item.cancel_raw) return sender.cancelPending(raw)
  return sender.retryPending()
}

function assertHeldRange(store: Store, ledger: CreditLedger, first: number, last: number, operator: string): RequestRecord[] {
  if (ledger.scope.chainId !== CHAIN_ID || ledger.scope.operator !== operator)
    throw new Error('The reorg recovery ledger belongs to another chain or operator.')
  const held = store.db.prepare('SELECT * FROM requests WHERE nonce BETWEEN ? AND ? ORDER BY nonce,key')
    .all(first, last) as unknown as RequestRecord[]
  if (held.length !== last - first + 1) throw new Error('Recover the complete newer journals before resolving reorged nonces.')
  for (let i = 0; i < held.length; i++) {
    const item = held[i], attempt = ledger.attempt(item.key), proof = JSON.parse(item.fee_data)
    if (item.nonce !== first + i || item.assured || proof.kind !== 'prepaid' || proof.ledgerId !== ledger.id ||
      !attempt || attempt.charged !== null || !item.raw || !item.hash)
      throw new Error('Every reorged nonce must retain its signed operation and unsettled credit hold.')
    if (proof.owner !== attempt.owner) throw new Error('A reorged operation belongs to another credit owner.')
    ledger.balance(attempt.owner)
    const tx = Transaction.from(item.raw)
    if (!tx.isSigned() || tx.hash !== item.hash || tx.serialized !== item.raw || tx.unsignedSerialized !== attempt.unsigned ||
      tx.chainId !== CHAIN || tx.from !== operator || tx.nonce !== item.nonce)
      throw new Error('A reorged signed operation disagrees with its reserved credit.')
  }
  return held
}

function checkLimits(gas: bigint, price: bigint, tip: bigint | undefined, base: bigint, minimum: bigint, balance: bigint, config: Settings): void {
  const effectivePrice = tip !== undefined && base + tip < price ? base + tip : price
  if (gas <= 0n || gas > MAX_GAS || price <= 0n ||
    (tip !== undefined && (tip <= 0n || tip > price || price < base + tip)) || effectivePrice < minimum ||
    price > config.maxGasPrice || gas * price > config.maxTransactionCost ||
    balance < gas * price + config.reserve || !config.dailyBudget)
    throw new Error('Recovery exceeds the explicit gas, balance or price limits.')
}
