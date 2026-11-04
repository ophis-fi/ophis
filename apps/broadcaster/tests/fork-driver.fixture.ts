import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LevelDOWN from 'leveldown'
import { ContractFactory, JsonRpcProvider, Wallet, Transaction, getAddress, type TransactionReceipt } from 'ethers'
import { disablePPOI } from '../../railgun/poi-policy'
import { POI } from '@railgun-community/engine'
import { ArtifactStore, createRailgunWallet, getRailgunWalletPrivateViewingKey, getRailgunWalletAddressData,
  setLoggers, startRailgunEngine, stopRailgunEngine } from '@railgun-community/wallet'
import { settings, NETWORK, TOKENS } from '../src/config'
import { initializeSecrets, readSecrets, Store, type RequestRecord } from '../src/storage'
import { RailgunSDK } from '../src/sdk'
import { FeeOracle, issueFee, ceilDiv } from '../src/fees'
import { Broadcaster } from '../src/broadcaster'
import { GUARD_ARTIFACT } from '../../railgun/operator/execution-guard-artifact'
import { assertExecutionGuardCode } from '../../railgun/operator/execution-guard'
import { probeGuardRace } from './guard-race.fixture'
import { forkProtectedSender } from './protected-sender.fixture'
import { PROXY, parseRequest } from '../src/transaction'
import { openRequest } from '../src/wire'
import { tryDecryptJSONDataWithSharedKey } from '@railgun-community/wallet'
import type { GasSigner } from '../src/signer'
import assert from 'node:assert/strict'

export async function forkOperator(rpcURL: string) {
  if (new URL(rpcURL).hostname !== '127.0.0.1') throw new Error('Fork test requires loopback.')
  const provider = new JsonRpcProvider(rpcURL, 1, { cacheTimeout: -1, batchMaxCount: 1 })
  const metadata = await provider.send('anvil_metadata', [])
  if (metadata.forkedNetwork?.chainId !== 1) throw new Error('An Ethereum Anvil fork is required.')
  const root = mkdtempSync(join(tmpdir(), 'ophis-operator-fork-'))
  initializeSecrets(join(root, 'operator.json'), 'fork')
  const secrets = readSecrets(join(root, 'operator.json'))
  let store = new Store(root)
  let closeTransport = async () => {}
  const stop = async () => {
    const closed = await Promise.allSettled([stopRailgunEngine(), closeTransport()])
    try { provider.destroy() } finally {
      try { store.close() } finally { rmSync(root, { recursive: true, force: true }) }
    }
    const failures = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Fork operator cleanup failed.')
  }
  try {
    const config = settings({ OPHIS_BROADCASTER_MODE: 'fork', OPHIS_BROADCASTER_RPC: rpcURL,
      OPHIS_BROADCASTER_ADMISSION: 'public',
      OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_STATE: root,
      OPHIS_BROADCASTER_MARGIN_BPS: '1500',
      OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '500000000', OPHIS_BROADCASTER_MAX_TX_COST_WEI: '1500000000000000',
      OPHIS_BROADCASTER_RESERVE_WEI: '1500000000000000', OPHIS_BROADCASTER_DAILY_BUDGET_WEI: '1500000000000000' })
    const wallet = new Wallet(secrets.gasKey)
    await provider.send('anvil_setBalance', [wallet.address, '0x56bc75e2d63100000'])
    const guard = await new ContractFactory(GUARD_ARTIFACT.abi, GUARD_ARTIFACT.bytecode, wallet.connect(provider))
      .deploy(wallet.address, NETWORK.relayAdapt7702Contract)
    await guard.waitForDeployment()
    config.executionGuard = await guard.getAddress()
    assertExecutionGuardCode(wallet.address, await provider.getCode(config.executionGuard),
      await provider.getCode(NETWORK.relayAdapt7702Contract))
    const protectedTransport = await forkProtectedSender(rpcURL, wallet.address, config.executionGuard, root)
    closeTransport = protectedTransport.close
    setLoggers(() => {}, () => {})
    disablePPOI(POI, NETWORK)
    await startRailgunEngine('ophistest', new LevelDOWN(join(root, 'wallet-db')), false,
      new ArtifactStore(async () => { throw new Error('No proving artifacts in the fork operator decoder.') }, async () => {}, async () => false),
      false, false)
    const feeWallet = await createRailgunWallet(secrets.encryptionKey, secrets.feeMnemonic!, undefined)
    const sdk = new RailgunSDK(config, secrets, store)
    sdk.walletId = feeWallet.id; sdk.address = feeWallet.railgunAddress
    sdk.privateViewingKey = getRailgunWalletPrivateViewingKey(feeWallet.id)
    sdk.publicViewingKey = Buffer.from(getRailgunWalletAddressData(sdk.address).viewingPublicKey).toString('hex')
    sdk.ready = () => true
    const rates = await new FeeOracle(provider, config.marginBps).rates()
    const initialGasBalance = await provider.getBalance(wallet.address)
    let submissions = 0, signatures = 0, rateMultiplier = 1n, underpaymentRejected = false
    store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('withdrawalPilot', 'historical-fork-pilot')
    const paid = (receipt: TransactionReceipt, commitment: string) => receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== NETWORK.proxyContract.toLowerCase()) return false
      const event = PROXY.parseLog(log)
      return event?.name === 'Transact' && Array.from(event.args.hash as string[]).some((hash) => hash.toLowerCase() === commitment.toLowerCase())
    })
    // This protocol fixture checks confirmed fee commitments; full wallet-history assurance is separate.
    sdk.assure = async (hash, proof) => {
      const receipt = await provider.getTransactionReceipt(hash)
      return !!receipt && receipt.status === 1 && (await provider.getBlockNumber()) - receipt.blockNumber + 1 >= 2 && paid(receipt, proof.commitment)
    }
    const signer: GasSigner = { address: wallet.address, signTransaction: async (transaction) => {
      signatures++
      return wallet.signTransaction(transaction)
    } }
    let receivedFeeCommitment: string | undefined
    let race: Awaited<ReturnType<typeof probeGuardRace>> | undefined
    const sender = {
      broadcastTransaction: async (raw: string) => {
        if (!(await provider.send('anvil_metadata', [])).forkedNetwork) throw new Error('Fork changed.')
        const tx = Transaction.from(raw)
        const journal = store.pending().find((r) => r.raw === raw && r.hash === tx.hash)
        assert(journal, 'Missing durable signed journal.')
        if (tx.type === 4 && !race) race = await probeGuardRace(provider, wallet, raw)
        submissions++
        const sent = await protectedTransport.sender.broadcastTransaction(raw)
        await provider.send('anvil_mine', [2])
        const receipt = await provider.getTransactionReceipt(sent.hash)
        assert.equal(receipt?.status, 1)
        const expectedFee = String(JSON.parse(journal.fee_data).commitment).toLowerCase()
        assert(paid(receipt!, expectedFee), 'The successful receipt must contain the authenticated private fee commitment.')
        receivedFeeCommitment = expectedFee
        return sent
      },
    }
    const makeService = () => new Broadcaster(config, store, sdk, provider, signer, sender,
      { rates: async () => Object.fromEntries(Object.entries(rates).map(([token, rate]) => [token, rate * rateMultiplier])) })
    let service = makeService()
    return {
      tokens: TOKENS,
      quote: (symbol: 'WETH' | 'USDC' | 'USDT' = 'WETH') => {
        const token = TOKENS.find((t) => t.symbol === symbol)!
        const q = issueFee(store, rates)
        return { feeAddress: sdk.address, feesID: q.id, feePerUnitGas: rates[getAddress(token.address)].toString(), expiration: q.expiration }
      },
      handle: async (message: string) => {
        if (!underpaymentRejected) {
          const request = await openRequest(Buffer.from(message), sdk.privateViewingKey, sdk.publicViewingKey)
          assert(request)
          rateMultiplier = 100n
          let rejected: Uint8Array | undefined
          try { rejected = await service.handle(Buffer.from(message)) } finally { rateMultiplier = 1n }
          assert(rejected)
          const decoded = tryDecryptJSONDataWithSharedKey(JSON.parse(Buffer.from(rejected).toString()).result, request.sharedKey) as { error?: string }
          assert(decoded.error?.includes('does not cover execution'))
          assert.equal(signatures, 0); assert.equal(submissions, 0); assert.equal(store.hasPending(), false)
          underpaymentRejected = true
        }
        const response = await service.handle(Buffer.from(message))
        if (!response) throw new Error('No fork operator response.')
        await service.reconcile()
        return Buffer.from(response).toString()
      },
      restart: () => { store.close(); store = new Store(root); service = makeService() },
      stats: async () => {
        const records = store.db.prepare('SELECT * FROM requests ORDER BY nonce').all() as unknown as RequestRecord[]
        const ledger = []
        for (const record of records) {
          const request = await openRequest(Buffer.from(record.envelope), sdk.privateViewingKey, sdk.publicViewingKey)
          assert(request)
          const payment = await sdk.fee(parseRequest(request.data, wallet.address, config))
          const [[token, amount]] = Object.entries(payment)
          const required = ceilDiv(BigInt(record.max_cost) * rates[getAddress(token)], 10n ** 18n)
          assert(amount >= required, 'Authenticated private fee must cover the full signed budget plus 15%.')
          ledger.push({ hash: record.hash, nonce: record.nonce, maxCostWei: record.max_cost,
            actualCostWei: record.actual_cost, token, fee: amount.toString(), minimumFee: required.toString() })
        }
        return { submissions, signatures, journaled: store.pending().length, exposureWei: String(store.exposure()),
          nativeGasSpentWei: String(initialGasBalance - await provider.getBalance(wallet.address)), ledger,
          historicalPilot: store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value,
          underpaymentRejected, fullWalletHistoryAssurance: false, fixedForkOracleRates: true,
          guard: config.executionGuard, race, receivedFeeCommitment, ...protectedTransport.stats() }
      },
      stop,
    }
  } catch (error) {
    try { await stop() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fork operator startup failed.') }
    throw error
  }
}
