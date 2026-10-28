import { CHAIN, CHAIN_NAME, CHAIN_ID, RPC_PATH, CONFIG, ENVIRONMENT, NETWORK, POI_NODES, VERSION } from './config'
import {
  createRailgunWallet,
  loadWalletByID,
  getWalletMnemonic,
  startRailgunEngine,
  getProver,
  loadProvider,
  setOnBalanceUpdateCallback,
  setOnUTXOMerkletreeScanCallback,
  fullWalletForID,
  EphemeralKeyManager,
  refreshBalances,
  refreshReceivePOIsForWallet,
  onBalancesUpdate,
  stopRailgunEngine,
  type SnarkJSGroth16,
} from '@railgun-community/wallet'
import {
  MerkletreeScanStatus,
  type RailgunBalancesEvent,
  type RailgunWalletInfo,
} from '@railgun-community/shared-models'
import { JsonRpcProvider, Mnemonic, randomBytes, hexlify, getBytes } from 'ethers'
import { groth16 } from 'snarkjs'
import { artifacts, encryptionKey, readPreference, walletDB, writePreference } from './storage'
import { RPC_BATCH_SIZE } from '../rpc-policy'

export interface WalletSession {
  info: RailgunWalletInfo
  key: string
  provider: JsonRpcProvider
  accounts: EphemeralKeyManager
}
interface WalletMetadata {
  id: string
  salt: string
}
const tab: { lock?: Promise<void> } = {}
const scan = { ready: false }

export function requireWalletSync(): void {
  if (!scan.ready)
    throw new Error(
      'Private history is not synchronized. Wait for synchronization or repair the RPC connection before spending.',
    )
}

export async function claimWalletTab(): Promise<void> {
  tab.lock ??= new Promise<void>((resolve, reject) => {
    if (!navigator.locks)
      return reject(new Error('This browser needs Web Locks support for safe wallet access.'))
    void navigator.locks
      .request(`ophisRailgun:${ENVIRONMENT}:v0`, { ifAvailable: true }, async (lock) => {
        if (!lock)
          return reject(
            new Error('This private wallet is open in another tab. Lock or close that tab first.'),
          )
        resolve()
        await new Promise<never>(() => {})
      })
      .catch(reject)
  })
  try {
    await tab.lock
  } catch (error) {
    tab.lock = undefined
    throw error
  }
}

export async function startWalletEngine(
  onBalance: (event: RailgunBalancesEvent) => void,
  onStatus: (status: string, ready: boolean) => void,
): Promise<JsonRpcProvider> {
  await claimWalletTab()
  const rpc = new URL(RPC_PATH, location.origin).href
  const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: RPC_BATCH_SIZE })
  try {
    if ((await provider.getNetwork()).chainId !== CHAIN) throw new Error(`${CHAIN_NAME} RPC required.`)
    const anvil: unknown = await provider.send('anvil_metadata', []).catch(() => undefined)
    const hardhat: unknown = await provider.send('hardhat_metadata', []).catch(() => undefined)
    if (
      ENVIRONMENT === 'fork' &&
      (!anvil || typeof anvil !== 'object' || !('forkedNetwork' in anvil) || !anvil.forkedNetwork)
    )
      throw new Error(`The local build requires an Anvil ${CHAIN_NAME} fork.`)
    if (ENVIRONMENT === 'ethereum' && (anvil || hardhat))
      throw new Error('Mainnet mode cannot use a local fork.')
    await startRailgunEngine('ophis', walletDB, false, artifacts, false, false, POI_NODES)
    // Upstream snarkjs types reject the sparse circuit inputs accepted by Railgun.
    getProver().setSnarkJSGroth16(groth16 as unknown as SnarkJSGroth16)
    setOnBalanceUpdateCallback(onBalance)
    setOnUTXOMerkletreeScanCallback((event) => {
      if (event.scanStatus === MerkletreeScanStatus.Complete) scan.ready = true
      if (event.scanStatus === MerkletreeScanStatus.Incomplete) scan.ready = false
      onStatus(
        `Scanning private balances: ${event.scanStatus}${event.progress == null ? '' : ` ${Math.round(event.progress * 100)}%`}`,
        scan.ready,
      )
    })
    await loadProvider(
      {
        chainId: CHAIN_ID,
        providers: [{ provider: rpc, priority: 1, weight: 2, maxLogsPerBatch: RPC_BATCH_SIZE }],
      },
      NETWORK,
      15_000,
    )
    return provider
  } catch (error) {
    provider.destroy()
    await stopRailgunEngine().catch(() => undefined)
    throw error
  }
}

export function newMnemonic(): string {
  return Mnemonic.fromEntropy(randomBytes(16)).phrase
}

export async function openWallet(
  provider: JsonRpcProvider,
  password: string,
  mnemonic: string | undefined,
): Promise<WalletSession> {
  await claimWalletTab()
  mnemonic = mnemonic?.trim().toLowerCase().split(/\s+/).join(' ')
  const stored = await readPreference<unknown>('wallet')
  if (
    stored !== undefined &&
    (!stored ||
      typeof stored !== 'object' ||
      !('id' in stored) ||
      typeof stored.id !== 'string' ||
      !('salt' in stored) ||
      typeof stored.salt !== 'string' ||
      !/^0x[0-9a-f]{64}$/i.test(stored.salt))
  )
    throw new Error(
      'Wallet metadata is damaged. Restore your Railgun recovery phrase in a fresh browser profile.',
    )
  const saved = stored as WalletMetadata | undefined
  if (mnemonic && saved)
    throw new Error(
      'A wallet already exists here. Unlock it; use a fresh browser profile to restore another wallet.',
    )
  if (
    mnemonic &&
    (![12, 24].includes(mnemonic.split(' ').length) || !Mnemonic.isValidMnemonic(mnemonic))
  )
    throw new Error('Enter a valid 12- or 24-word Railgun recovery phrase.')
  if (!mnemonic && !saved) throw new Error('Create or restore a Railgun wallet first.')
  const salt = saved ? getBytes(saved.salt) : randomBytes(32)
  const key = await encryptionKey(password, salt)
  // SDK loads can return a cached wallet without authenticating this key.
  if (saved) await getWalletMnemonic(key, saved.id)
  const info = saved
    ? await loadWalletByID(key, saved.id, false)
    : await createRailgunWallet(key, mnemonic || '', undefined)
  if (!saved)
    await writePreference('wallet', { id: info.id, salt: hexlify(salt) } satisfies WalletMetadata)
  const accounts = new EphemeralKeyManager(fullWalletForID(info.id), key)
  await accounts.scanHistoryForEphemeralIndex(CONFIG.chain)
  return { info, key, provider, accounts }
}

export async function syncWallet(session: WalletSession): Promise<void> {
  await refreshBalances(CONFIG.chain, [session.info.id])
  await refreshReceivedBalances(session)
}

const receiveRefreshes = new Map<string, Promise<void>>()

export function refreshReceivedBalances(session: WalletSession): Promise<void> {
  const id = session.info.id
  let refresh = receiveRefreshes.get(id)
  if (!refresh) {
    refresh = (async () => {
      await refreshReceivePOIsForWallet(VERSION, NETWORK, id)
      await onBalancesUpdate(VERSION, fullWalletForID(id), CONFIG.chain)
    })().finally(() => { receiveRefreshes.delete(id) })
    receiveRefreshes.set(id, refresh)
  }
  return refresh
}
