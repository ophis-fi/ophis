import { createServer } from 'node:http'
import { statfsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import LevelDOWN from 'leveldown'
import { JsonRpcProvider, Wallet } from 'ethers'
import { ProtectedEthereumProvider } from '../../railgun/operator/protected-provider'
import { CHAIN, CHAIN_ID, NATIVE_SYMBOL, settings, TOPICS } from './config'
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

process.umask(0o077)

async function run(): Promise<void> {
  const command = process.argv[2] ?? 'run'
  const config = settings(process.env)
  const identity = { chainId: CHAIN_ID, nativeSymbol: NATIVE_SYMBOL, operatorAddress: config.operatorAddress ?? null }
  const socketPath = join(tmpdir(), CHAIN_ID === 1 ? 'ophis-broadcaster' : `ophis-broadcaster-${CHAIN_ID}`, 'unlock.sock')
  if (command === 'unlock') {
    const data = await stdinUnlock()
    try { await sendUnlock(socketPath, data) } finally { data.fill(0) }
    console.log(JSON.stringify({ status: 'unlocked' }))
    return
  }
  if (!['init', 'migrate', 'snapshot', 'check', 'status', 'report', 'monitor', 'acknowledge-loss', 'retry', 'cancel', 'deploy-guard', 'sync', 'run'].includes(command))
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
  const provider = new JsonRpcProvider(config.rpc, CHAIN_ID, { batchMaxCount: 1, cacheTimeout: -1, staticNetwork: command === 'monitor' })
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
    if (command === 'report') {
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
        const currentBalance = health?.synchronized === true && typeof health.feeBalancesAt === 'number' &&
          Math.abs(Date.now() - health.feeBalancesAt) < 45_000
        console.log(JSON.stringify({ ...accountingReport(journal), ...identity, spendablePrivateFees: currentBalance ? health?.feeBalances : undefined,
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
    if (!config.enabled && command !== 'sync') {
      console.log(JSON.stringify({ status: 'unarmed', gasWalletAddress: wallet.address }))
      while (!stopping) { assertDisk(config.state); await delay(1000) }
      return
    }
    await sdk.start(provider)
    console.log(JSON.stringify({ status: 'synchronizing', feeIdentity: sdk.address, gasWalletAddress: wallet.address }))
    waku = new WakuRelay(config.waku, config.mode === 'fork' ? '/waku/2/rs/0/0' : undefined)
    if (command === 'run') await waku.subscribe()
    let lastRefresh = 0, failures = 0
    while (!stopping) {
      assertDisk(config.state)
      try {
        if (Date.now() - lastRefresh >= 30_000) {
          lastRefresh = Date.now()
          metrics.ready = await broadcaster.available()
          if (sdk.ready()) { metrics.feeBalances = await sdk.balances(); metrics.feeBalancesAt = Date.now() }
          else { delete metrics.feeBalances; delete metrics.feeBalancesAt }
          if (!reconcile) reconcile = broadcaster.reconcile()
            .catch(() => { metrics.errors++ }).finally(() => { reconcile = undefined })
          if (command === 'run' && config.enabled && sdk.ready())
            await waku.publish(TOPICS.fees, await broadcaster.feeAdvertisement())
        }
        if (command === 'run' && config.enabled) {
          for (const payload of await waku.messages()) {
            if (stopping) break
            const reply = await broadcaster.handle(payload)
            if (reply) await waku.publish(TOPICS.response, reply)
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
