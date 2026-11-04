import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LevelDOWN from 'leveldown'
import { ContractFactory, JsonRpcProvider, Wallet, Transaction } from 'ethers'
import { disablePPOI } from '../../railgun/poi-policy'
import { POI } from '@railgun-community/engine'
import { ArtifactStore, createRailgunWallet, getRailgunWalletPrivateViewingKey, getRailgunWalletAddressData,
  setLoggers, startRailgunEngine, stopRailgunEngine } from '@railgun-community/wallet'
import { settings, NETWORK } from '../src/config'
import { initializeSecrets, readSecrets, Store } from '../src/storage'
import { RailgunSDK } from '../src/sdk'
import { issueFee } from '../src/fees'
import { Broadcaster } from '../src/broadcaster'
import { GUARD_ARTIFACT } from '../../railgun/operator/execution-guard-artifact'
import { assertExecutionGuardCode } from '../../railgun/operator/execution-guard'
import { probeGuardRace } from './guard-race.fixture'
import { forkProtectedSender } from './protected-sender.fixture'
import { PROXY } from '../src/transaction'
import assert from 'node:assert/strict'

export async function forkOperator(rpcURL: string) {
  if (new URL(rpcURL).hostname !== '127.0.0.1') throw new Error('Fork test requires loopback.')
  const provider = new JsonRpcProvider(rpcURL, 1, { cacheTimeout: -1, batchMaxCount: 1 })
  const metadata = await provider.send('anvil_metadata', [])
  if (metadata.forkedNetwork?.chainId !== 1) throw new Error('An Ethereum Anvil fork is required.')
  const root = mkdtempSync(join(tmpdir(), 'ophis-operator-fork-'))
  initializeSecrets(join(root, 'operator.json'), 'fork')
  const secrets = readSecrets(join(root, 'operator.json')), store = new Store(root)
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
      OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_STATE: root,
      OPHIS_BROADCASTER_MARGIN_BPS: '1500',
      OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '10000000000', OPHIS_BROADCASTER_MAX_TX_COST_WEI: '100000000000000000',
      OPHIS_BROADCASTER_RESERVE_WEI: '100000000000000000', OPHIS_BROADCASTER_DAILY_BUDGET_WEI: '1000000000000000000' })
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
    const rates = { [NETWORK.baseToken.wrappedAddress]: 10n ** 18n }
    let submissions = 0
    let receivedFeeCommitment: string | undefined
    let race: Awaited<ReturnType<typeof probeGuardRace>> | undefined
    const service = new Broadcaster(config, store, sdk, provider, wallet, {
      broadcastTransaction: async (raw) => {
        if (!(await provider.send('anvil_metadata', [])).forkedNetwork) throw new Error('Fork changed.')
        const tx = Transaction.from(raw)
        const journal = store.pending().find((r) => r.raw === raw && r.hash === tx.hash)
        assert(journal, 'Missing durable signed journal.')
        if (!race) race = await probeGuardRace(provider, wallet, raw)
        submissions++
        const sent = await protectedTransport.sender.broadcastTransaction(raw)
        await provider.send('anvil_mine', [2])
        const receipt = await provider.getTransactionReceipt(sent.hash)
        assert.equal(receipt?.status, 1)
        const expectedFee = String(JSON.parse(journal.fee_data).commitment).toLowerCase()
        const paid = receipt!.logs.some((log) => {
          if (log.address.toLowerCase() !== NETWORK.proxyContract.toLowerCase()) return false
          const event = PROXY.parseLog(log)
          return event?.name === 'Transact' && Array.from(event.args.hash as string[]).some((hash) => hash.toLowerCase() === expectedFee)
        })
        assert(paid, 'The successful receipt must contain the authenticated private fee commitment.')
        receivedFeeCommitment = expectedFee
        return sent
      },
    }, { rates: async () => rates })
    return {
      quote: () => { const q = issueFee(store, rates); return { feeAddress: sdk.address, feesID: q.id, feePerUnitGas: '1000000000000000000' } },
      handle: async (message: string) => {
        const response = await service.handle(Buffer.from(message))
        if (!response) throw new Error('No fork operator response.')
        return Buffer.from(response).toString()
      },
      stats: () => ({ submissions, journaled: store.pending().length, exposureWei: String(store.exposure()),
        guard: config.executionGuard, race, receivedFeeCommitment, ...protectedTransport.stats() }),
      stop,
    }
  } catch (error) {
    try { await stop() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fork operator startup failed.') }
    throw error
  }
}
