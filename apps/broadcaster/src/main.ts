import { createServer } from 'node:http'
import { statfsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import LevelDOWN from 'leveldown'
import { JsonRpcProvider, Wallet } from 'ethers'
import { ProtectedEthereumProvider } from '../../railgun/operator/protected-provider'
import { CHAIN, CHAIN_ID, FEE_LIFETIME_MS, NATIVE_SYMBOL, NETWORK, settings, TOPICS } from './config'
import { assertDisk, initializeSecrets, parseMainnetSecrets, privateDirectory, privateFile, readSecrets, Store, type Secrets } from './storage'
import { RailgunSDK } from './sdk'
import { FeeOracle } from './fees'
import { WakuRelay } from './waku'
import { Broadcaster } from './broadcaster'
import { recover } from './recovery'
import { receiveUnlock, sendUnlock, stdinUnlock } from './unlock-socket'
import { migrateOperator } from './migrate'
import { snapshotCriticalState } from './backup'
import { deployGuard, type GuardApproval } from './guard-deployment'
import { accountingReport, acknowledgeLoss, localHealth, monitor, monitorMetrics } from './operations'
import { CreditLedger } from './credit'
import { finalizedCreditReceipt } from './credit-payment'
import { ownerCostPreflight } from './owner-cost'
import { PROXY, uint } from './transaction'
import { object } from './wire'
import { readAnonCollectionBaseFee } from './anon-native-collection'
import { BNBTraceProvider } from './bnb-trace-provider'

process.umask(0o077)

async function run(): Promise<void> {
  const command = process.argv[2] ?? 'run'
  const ownerSyncCommand = command === 'prepare-owner-operation' || command === 'reject-unrelated-owner-payout'
  if (command === 'sync' && (process.argv.length > 4 || (process.argv[3] !== undefined && process.argv[3] !== '--initialize-credit')))
    throw new Error('Sync accepts only the explicit --initialize-credit option.')
  const initializeCredit = command === 'sync' && process.argv[3] === '--initialize-credit'
  // Inspection and explicit ledger initialization never enable transaction submission.
  const config = settings(command === 'sync' ? { ...process.env, OPHIS_BROADCASTER_ENABLED: '0' } : process.env)
  const identity = { chainId: CHAIN_ID, nativeSymbol: NATIVE_SYMBOL, operatorAddress: config.operatorAddress ?? null }
  const socketPath = join(tmpdir(), CHAIN_ID === 1 ? 'ophis-broadcaster' : `ophis-broadcaster-${CHAIN_ID}`, 'unlock.sock')
  if (command === 'unlock') {
    const data = await stdinUnlock()
    try { await sendUnlock(socketPath, data) } finally { data.fill(0) }
    console.log(JSON.stringify({ status: 'unlocked' }))
    return
  }
  if (!['init', 'migrate', 'snapshot', 'check', 'status', 'report', 'owner-cost-preflight', 'prepare-owner-operation', 'record-owner-payout', 'reject-owner-payout', 'reject-unrelated-owner-payout', 'monitor', 'acknowledge-loss', 'refunds', 'record-refund-payout', 'retry', 'cancel', 'deploy-guard', 'sync', 'run'].includes(command))
    throw new Error('Unsupported broadcaster command.')
  privateDirectory(config.state)
  if (command !== 'monitor') assertDisk(config.state)
  if (command === 'snapshot') {
    if (!process.argv[3]) throw new Error('A private snapshot directory is required.')
    await snapshotCriticalState(config.state, process.argv[3])
    console.log(JSON.stringify({ status: 'snapshot-complete' }))
    return
  }
  if (command === 'init') {
    console.log(JSON.stringify({ gasWalletAddress: initializeSecrets(config.secrets, config.mode), funded: false }))
    return
  }
  const provider = config.traceRpc ? new BNBTraceProvider(config.rpc, config.traceRpc, config.mode)
    : new JsonRpcProvider(config.rpc, CHAIN_ID, { batchMaxCount: 1, cacheTimeout: -1, staticNetwork: command === 'monitor' })
  provider.pollingInterval = 15_000
  let store: Store | undefined, sdk: RailgunSDK | undefined, sender: ProtectedEthereumProvider | undefined
  let waku: WakuRelay | undefined
  let lock: ReturnType<typeof LevelDOWN> | undefined
  let server: ReturnType<typeof createServer> | undefined
  let reconcile: Promise<void> | undefined
  let stopping = false
  const abort = new AbortController()
  const stop = () => { stopping = true; abort.abort() }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const oracle = new FeeOracle(provider, config.marginBps)
    const port = Number(process.env.OPHIS_BROADCASTER_PORT ?? '4340')
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid health port.')
    if (command === 'monitor') {
      if (process.argv.length > 3 && (process.argv.length !== 4 || process.argv[3] !== '--prometheus')) throw new Error('Invalid monitor output.')
      const result = await monitor(config, provider, oracle, port)
      if (process.argv[3] === '--prometheus') process.stdout.write(monitorMetrics(result))
      else console.log(JSON.stringify(result))
      process.exitCode = result.ok ? 0 : 2
      return
    }
    const fork: unknown = await provider.send('anvil_metadata', []).catch(() => undefined)
    const hardhat: unknown = await provider.send('hardhat_metadata', []).catch(() => undefined)
    if ((await provider.getNetwork()).chainId !== CHAIN || (config.mode === 'mainnet' && (fork || hardhat)) ||
      (config.mode === 'fork' && (!fork || typeof fork !== 'object' || !('forkedNetwork' in fork) || !fork.forkedNetwork)))
      throw new Error('Read node does not match the selected mainnet/fork environment.')
    if (command === 'report' || command === 'owner-cost-preflight') {
      const journal = new DatabaseSync(join(config.state, 'requests.sqlite'), { readOnly: true })
      try {
        journal.exec('BEGIN')
        const chain = journal.prepare('SELECT value FROM settings WHERE key=?').get('chainId')
        const operator = journal.prepare('SELECT value FROM settings WHERE key=?').get('operatorAddress')
        if (!config.operatorAddress || chain?.value !== String(CHAIN_ID) || operator?.value !== config.operatorAddress)
          throw new Error('The report journal does not match the selected chain and gas wallet.')
        const health = await localHealth(port).catch(() => undefined)
        if (health && (health.chainId !== CHAIN_ID || health.nativeSymbol !== NATIVE_SYMBOL || health.operatorAddress !== config.operatorAddress))
          throw new Error('The current health sample belongs to a different chain or gas wallet.')
        if (command === 'owner-cost-preflight') {
          if (process.argv.length !== 4 || !health) throw new Error('Provide a quote file and a current matching balance sample.')
          const file = privateFile(process.argv[3])
          if (file.length > 16_384) throw new Error('Owner cost quote must be a bounded JSON file.')
          const quote = JSON.parse(file.toString('utf8'))
          const fee = await provider.call({ to: NETWORK.proxyContract, data: PROXY.encodeFunctionData('unshieldFee') })
          const result = ownerCostPreflight(journal, config, quote,
            { health, unshieldFeeBps: BigInt(PROXY.decodeFunctionResult('unshieldFee', fee)[0]),
              gatewayFeeBps: await readAnonCollectionBaseFee(provider) })
          console.log(JSON.stringify(result))
          process.exitCode = result.withinBudget ? 0 : 2
          return
        }
        const currentBalance = health?.synchronized === true && typeof health.feeBalancesAt === 'number' &&
          Math.abs(Date.now() - health.feeBalancesAt) < 45_000
        console.log(JSON.stringify({ ...accountingReport(journal), ...identity, privateFeeWalletBalances: currentBalance ? health?.feeBalances : undefined,
          privateBalanceIncludesCustomerCredit: true,
          privateBalanceSampledAt: currentBalance ? health?.feeBalancesAt : undefined, maximumWithdrawalGasWei: config.maxTransactionCost.toString(),
          treasury: '0x58707c6C1E111c21cba4C9C8caE144175F84EceE',
          collectionRequiresOwnerQuotes: true }))
      } finally { journal.close() }
      return
    }
    if (command === 'check') {
      const rates = await oracle.rates(), disk = statfsSync(config.state)
      console.log(JSON.stringify({ ...identity, mode: config.mode, signingEnabled: config.enabled,
        pricedFeeTokens: Object.keys(rates), freeDiskGiB: Math.floor(disk.bavail * disk.bsize / 1024 ** 3) }))
      return
    }
    // LevelDB's native exclusive lock also covers unarmed mode and manual recovery.
    lock = new LevelDOWN(join(config.state, 'operator-lock'))
    await new Promise<void>((resolve, reject) => lock!.open((error) => error ? reject(error) : resolve()))
    store = new Store(config.state)
    if (command !== 'migrate') store.bindIdentity(CHAIN_ID, config.operatorAddress)
    if (command === 'record-owner-payout' || command === 'reject-owner-payout') {
      if (process.argv.length !== 5) throw new Error('Provide the saved owner intent and exact payout transaction hash.')
      const ledger = CreditLedger.load(store), receipt = await finalizedCreditReceipt(provider, process.argv[4])
      if (command === 'reject-owner-payout') ledger.rejectOwnerPayout(process.argv[3], receipt)
      else ledger.recordOwnerPayout(process.argv[3], receipt)
      console.log(JSON.stringify({ ...identity, status: command === 'reject-owner-payout'
        ? 'nonspending-owner-payout-rejected-intent-still-held' : 'owner-payout-recorded-awaiting-private-verification',
        intentKey: process.argv[3], transactionHash: process.argv[4], fundsTransferred: false }))
      return
    }
    if (command === 'refunds' || command === 'record-refund-payout') {
      const ledger = CreditLedger.load(store)
      if (command === 'refunds') {
        if (process.argv.length !== 3) throw new Error('Refund listing accepts no arguments.')
        const pending = store.db.prepare('SELECT key,recipient,gross,net,created FROM credit_refunds WHERE transaction_hash IS NULL ORDER BY created,key').all()
        console.log(JSON.stringify({ ...identity, token: ledger.scope.token, pending, privateOperatorOutput: true }))
      } else {
        if (process.argv.length !== 5) throw new Error('Provide the saved refund key and exact owner payout transaction hash.')
        ledger.recordRefundPayout(process.argv[3], await finalizedCreditReceipt(provider, process.argv[4]))
        console.log(JSON.stringify({ ...identity, status: 'owner-payout-recorded-awaiting-private-verification',
          refundKey: process.argv[3], transactionHash: process.argv[4], fundsTransferred: false }))
      }
      return
    }
    if (command === 'acknowledge-loss') {
      if (process.argv.length !== 5) throw new Error('Provide the request key and an audit reason.')
      await acknowledgeLoss(process.argv[3], process.argv[4], config, store, provider)
      console.log(JSON.stringify({ status: 'finalized-gas-loss-acknowledged', feeReceived: false }))
      return
    }
    if (command === 'migrate') {
      const legacy = readSecrets(config.secrets), address = new Wallet(legacy.gasKey).address
      if (config.enabled || await provider.getBalance(address) !== 0n ||
        await provider.getTransactionCount(address, 'latest') !== await provider.getTransactionCount(address, 'pending'))
        throw new Error('Stop sponsorship and reconcile the old gas account before custody migration.')
      const certificate = process.argv[3]
      if (!certificate) throw new Error('Migration requires the verified off-server recovery certificate.')
      console.log(JSON.stringify(await migrateOperator(config, store, certificate)))
      return
    }
    if (command === 'status') {
      const address = config.mode === 'mainnet' ? config.operatorAddress : new Wallet(readSecrets(config.secrets).gasKey).address
      if (!address) throw new Error('Configure the dedicated public gas address.')
      store.bindIdentity(CHAIN_ID, address)
      identity.operatorAddress = address
      const pending = store.pending()
      console.log(JSON.stringify({ ...identity, gasWalletAddress: address, balanceWei: String(await provider.getBalance(address)),
        exposureWei: String(store.exposure()), unresolved: pending.filter((r) => !r.confirmed).map((r) => ({
          hash: r.hash, nonce: r.nonce, cancellationHash: r.cancel_hash, feeExpired: r.fee_expiration <= Date.now(),
        })), feeAssurancePending: pending.filter((r) => r.confirmed && !r.assured).length }))
      return
    }
    const metrics: { ready: boolean; errors: number; locked: boolean; feeBalances?: Record<string, string>; feeBalancesAt?: number } =
      { ready: false, errors: 0, locked: config.mode === 'mainnet' }
    server = createServer((request, response) => {
      if (request.url !== '/health') { response.writeHead(404).end(); return }
      response.setHeader('Content-Type', 'application/json')
      const pending = store!.pending()
      response.end(JSON.stringify({ ...identity, mode: config.mode, admission: config.admission, enabled: config.enabled, ready: metrics.ready, locked: metrics.locked,
        synchronized: sdk?.ready() ?? false,
        wakuSaturated: waku?.saturated ?? false,
        pending: pending.filter((r) => !r.confirmed).length,
        feeAssurancePending: pending.filter((r) => r.confirmed && !r.assured).length, errors: metrics.errors,
        feeBalances: metrics.feeBalances, feeBalancesAt: metrics.feeBalancesAt }))
    })
    if (!ownerSyncCommand)
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(port, '127.0.0.1', resolve) })
    let secrets: Secrets
    if (config.mode === 'mainnet') {
      if (!config.operatorAddress) throw new Error('Configure the dedicated public gas address before unlocking.')
      // The encrypted file is never a plaintext fallback. Decryption happens off-server.
      const sealed = JSON.parse(privateFile(config.secrets).toString())
      if (sealed?.version !== 1 || typeof sealed.ciphertext !== 'string') throw new Error('An encrypted operator file is required.')
      const unlock = await receiveUnlock(socketPath, (data) => parseMainnetSecrets(data, config.operatorAddress!), abort.signal)
      console.log(JSON.stringify({ status: 'locked', gasWalletAddress: config.operatorAddress }))
      try { secrets = await unlock.value } finally { await unlock.close() }
      metrics.locked = false
    } else secrets = readSecrets(config.secrets)
    const wallet = new Wallet(secrets.gasKey)
    store.bindIdentity(CHAIN_ID, wallet.address)
    identity.operatorAddress = wallet.address
    if (await provider.getCode(wallet.address) !== '0x') throw new Error('The dedicated gas wallet must be undelegated.')
    if (command === 'deploy-guard') {
      if (store.pending().length || store.nonceBlocked(0)) throw new Error('Reconcile outstanding or historically reserved operator nonces before deploying.')
      const approval = JSON.parse(privateFile(join(config.state, 'guard-deployment-approval.json')).toString()) as GuardApproval
      console.log(JSON.stringify(await deployGuard(config, approval, provider, wallet)))
      return
    }
    if (config.mode === 'mainnet') sender = new ProtectedEthereumProvider(config.rpc, wallet.address, config.state, config.executionGuard, CHAIN_ID)
    if (command === 'retry' || command === 'cancel') {
      if (!sender) throw new Error('Manual recovery is a mainnet protected-transport command; test its function on a fork.')
      const hash = await recover(command, process.argv.slice(3), config, store, provider, wallet, sender)
      console.log(JSON.stringify({ status: 'protected-submission', hash }))
      return
    }
    sdk = new RailgunSDK(config, secrets, store)
    const broadcaster = new Broadcaster(config, store, sdk, provider, wallet, sender ?? provider, oracle)
    const hasCredits = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_identity'").get()
    if (!config.enabled && command !== 'sync' && !ownerSyncCommand && !hasCredits) {
      console.log(JSON.stringify({ status: 'unarmed', gasWalletAddress: wallet.address }))
      while (!stopping) { assertDisk(config.state); await delay(1000) }
      return
    }
    await sdk.start(provider)
    if (command === 'reject-unrelated-owner-payout') {
      if (process.argv.length !== 5) throw new Error('Provide the held owner intent and exact unrelated transaction hash.')
      const ledger = CreditLedger.load(store)
      if (ledger.scope.recipient !== sdk.address) throw new Error('The synchronized fee identity does not match the owner journal.')
      const evidence = await sdk.unrelatedOwnerPayout(provider, ledger.scope, ledger.accountedNotes(), process.argv[4])
      ledger.rejectOwnerPayout(process.argv[3], evidence.receipt, evidence.proof)
      console.log(JSON.stringify({ ...identity, status: 'unrelated-owner-payout-rejected-intent-still-held',
        intentKey: process.argv[3], transactionHash: process.argv[4], fundsTransferred: false }))
      return
    }
    if (command === 'prepare-owner-operation') {
      const ledger = CreditLedger.load(store)
      if (ledger.scope.recipient !== sdk.address) throw new Error('The synchronized fee identity does not match the owner plan.')
      const backing = await sdk.accountedCreditBacking(provider, ledger.accountedNotes(), config.creditCollectionInputs!)
      if (process.argv.length !== 4) throw new Error('Provide an owner-reviewed operation plan file.')
      const bytes = privateFile(process.argv[3])
      if (bytes.length > 16_384) throw new Error('Owner operation plans must be bounded JSON files.')
      const plan: unknown = JSON.parse(bytes.toString('utf8'))
      const now = Date.now()
      if (!object(plan) || (plan.kind !== 'refund' && plan.kind !== 'collection') ||
        plan.chainId !== CHAIN_ID || plan.ledgerId !== ledger.id || plan.operator !== ledger.scope.operator ||
        plan.token !== ledger.scope.token || !Number.isSafeInteger(plan.expiresAt) ||
        Number(plan.expiresAt) <= now || Number(plan.expiresAt) > now + FEE_LIFETIME_MS ||
        plan.inputLimit !== config.creditCollectionInputs || plan.outputLimit !== config.creditCollectionOutputs ||
        plan.proofLimit !== config.creditCollectionProofs || plan.marginBps !== config.marginBps.toString() ||
        (plan.kind === 'refund' ? typeof plan.refundKey !== 'string' : plan.refundKey !== undefined))
        throw new Error('The owner operation plan does not match the current ledger, limits or quote lifetime.')
      const maximumPrivateFee = uint(plan.maximumPrivateFee)
      if (maximumPrivateFee > config.maxTransactionCost) throw new Error('The owner private fee exceeds the configured cost cap.')
      const collectionFees = plan.kind === 'collection' ? {
        unshieldFeeBps: BigInt(PROXY.decodeFunctionResult('unshieldFee', await provider.call({
          to: NETWORK.proxyContract, data: PROXY.encodeFunctionData('unshieldFee'),
        }))[0]), gatewayFeeBps: await readAnonCollectionBaseFee(provider),
      } : undefined
      if (Number(plan.expiresAt) <= Date.now()) throw new Error('The owner quote expired during fee verification.')
      const intent = ledger.prepareOwnerOperation({ kind: plan.kind as 'refund' | 'collection',
        refundKey: plan.refundKey as string | undefined, maximumPrivateFee, minimumNative: uint(plan.minimumNative),
        inputLimit: config.creditCollectionInputs!, outputLimit: config.creditCollectionOutputs!,
        proofLimit: config.creditCollectionProofs!, marginBps: config.marginBps, collectionFees }, backing)
      console.log(JSON.stringify({ ...identity, status: 'owner-operation-held', intent, fundsTransferred: false }))
      return
    }
    console.log(JSON.stringify({ status: 'synchronizing', feeIdentity: sdk.address, gasWalletAddress: wallet.address }))
    if (command === 'run') {
      waku = new WakuRelay(config.waku, config.mode === 'fork' ? '/waku/2/rs/0/0' : undefined)
      await waku.subscribe()
    }
    let lastRefresh = 0, failures = 0, syncReported = false
    while (!stopping) {
      assertDisk(config.state)
      try {
        if (Date.now() - lastRefresh >= 30_000) {
          lastRefresh = Date.now()
          metrics.ready = await broadcaster.available()
          if (sdk.ready()) {
            metrics.feeBalances = await sdk.balances(); metrics.feeBalancesAt = Date.now()
            if (command === 'sync' && !syncReported) {
              const credit = initializeCredit ? await broadcaster.creditInfo() : undefined
              console.log(JSON.stringify({ ...identity, status: initializeCredit ? 'credit-ledger-ready' : 'sync-ready',
                feeIdentity: sdk.address, credit, signingEnabled: false, fundsTransferred: false }))
              syncReported = true
            }
          }
          else { delete metrics.feeBalances; delete metrics.feeBalancesAt }
          if (command === 'run' && !reconcile) reconcile = broadcaster.reconcile()
            .catch(() => { metrics.errors++ }).finally(() => { reconcile = undefined })
          if (command === 'run' && sdk.ready())
            await waku!.publish(TOPICS.fees, await broadcaster.feeAdvertisement())
        }
        if (command === 'run') {
          for (const message of await waku!.messages()) {
            if (stopping) break
            const reply = await broadcaster.handle(message.payload)
            if (reply) await waku!.publish(message.responseTopic, reply)
          }
        }
        failures = 0
      } catch { metrics.errors++; metrics.ready = false; failures++ }
      await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)))
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
    await reconcile
    try { await sdk?.stop() } finally {
      sender?.destroy(); provider.destroy(); store?.close()
      if (lock?.status === 'open') await new Promise<void>((resolve, reject) => lock!.close((error) => error ? reject(error) : resolve()))
    }
  }
}

// The SDK retains background timers after unload; exit only after every journal and provider closes.
run().then(() => process.exit(process.exitCode ?? 0)).catch(() => {
  console.error('Broadcaster stopped: configuration, lock, storage or dependency checks failed. No secret values were logged.')
  process.exit(1)
})
