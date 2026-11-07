import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import LevelDOWN from 'leveldown'
import { groth16 } from 'snarkjs'
import {
  ArtifactStore, startRailgunEngine, stopRailgunEngine, loadProvider, createRailgunWallet, loadWalletByID,
  getRailgunWalletPrivateViewingKey, getRailgunWalletAddressData, signWithWalletViewingKey,
  createViewOnlyRailgunWallet, getWalletShareableViewingKey, viewOnlyWalletForID,
  setLoggers, setOnUTXOMerkletreeScanCallback,
  walletForID, parseRailgunTokenAddress,
  getProver, refreshBalances,
  unloadProvider,
  balanceForERC20Token,
  type SnarkJSGroth16,
} from '@railgun-community/wallet'
import { ByteUtils, ByteLength, POI } from '@railgun-community/engine'
import { MerkletreeScanStatus,
  type PreTransactionPOIsPerTxidLeafPerList } from '@railgun-community/shared-models'
import { getAddress, JsonRpcProvider } from 'ethers'
import { CHAIN_ID, NETWORK, NETWORK_NAME, TOKENS, VERSION, type Settings } from './config'
import { assertDisk, privateDirectory, type Secrets, type Store } from './storage'
import { PROXY, type ParsedRequest } from './transaction'
import { disablePPOI } from '../../railgun/poi-policy'

export interface FeeProof {
  railgunTxid: string; utxoTreeIn: number; commitment: string; notePublicKey: string
  pois: PreTransactionPOIsPerTxidLeafPerList
}

export class RailgunSDK {
  walletId = ''
  address = ''
  privateViewingKey: Uint8Array = new Uint8Array()
  publicViewingKey = ''
  private utxoReady = false
  private started = false
  private providerLoaded = false
  constructor(private readonly config: Settings, private readonly secrets: Secrets, private readonly store: Store) {}

  async start(provider?: JsonRpcProvider): Promise<void> {
    if (this.config.chainId !== CHAIN_ID || (provider && (await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)))
      throw new Error('The fee wallet must use its bound broadcaster chain.')
    const root = join(this.config.state, 'artifacts')
    privateDirectory(root)
    const artifactPath = (path: string): string => {
      const target = resolve(root, path)
      if (!target.startsWith(root + sep)) throw new Error('Invalid SDK artifact path.')
      return target
    }
    const artifacts = new ArtifactStore(
      (path) => readFile(artifactPath(path)),
      async (dir, path, data) => {
        assertDisk(this.config.state)
        await mkdir(artifactPath(dir), { recursive: true, mode: 0o700 })
        await writeFile(artifactPath(path), data, { mode: 0o600 })
      },
      async (path) => { try { await access(artifactPath(path)); return true } catch { return false } },
    )
    // SDK errors can contain RPC credentials or private calldata; emit only our own status messages.
    setLoggers(() => {}, () => {})
    disablePPOI(POI, NETWORK)
    this.started = true
    await startRailgunEngine('ophisrelay', new LevelDOWN(join(this.config.state, 'wallet-db')), false,
      artifacts, false, false)
    setOnUTXOMerkletreeScanCallback((event) => {
      if (event.chain.id === CHAIN_ID && event.chain.type === NETWORK.chain.type)
        this.utxoReady = event.scanStatus === MerkletreeScanStatus.Complete
    })
    getProver().setSnarkJSGroth16(groth16 as unknown as SnarkJSGroth16)
    const existing = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get('walletId') as { value: string } | undefined
    const creation = provider ? { [NETWORK_NAME]: await provider.getBlockNumber() } : undefined
    const wallet = existing
      ? await loadWalletByID(this.secrets.encryptionKey, existing.value, !!this.secrets.feeViewingKey)
      : this.secrets.feeViewingKey
        ? await createViewOnlyRailgunWallet(this.secrets.encryptionKey, this.secrets.feeViewingKey, undefined)
        : await createRailgunWallet(this.secrets.encryptionKey, this.secrets.feeMnemonic!, creation)
    if (this.secrets.feeViewingKey) {
      viewOnlyWalletForID(wallet.id)
      if (await getWalletShareableViewingKey(wallet.id) !== this.secrets.feeViewingKey)
        throw new Error('The persisted fee wallet does not match its viewing identity.')
    }
    this.walletId = wallet.id; this.address = wallet.railgunAddress
    this.privateViewingKey = getRailgunWalletPrivateViewingKey(this.walletId)
    this.publicViewingKey = Buffer.from(getRailgunWalletAddressData(this.address).viewingPublicKey).toString('hex')
    this.store.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('walletId', this.walletId)
    if (provider) {
      this.providerLoaded = true
      await loadProvider({ chainId: CHAIN_ID, providers: [{ provider: this.config.rpc, priority: 1, weight: 2, maxLogsPerBatch: 1000 }] },
        NETWORK_NAME, 15_000)
      await refreshBalances(NETWORK.chain, [this.walletId])
    }
  }

  async prepareViewOnly(encryptionKey: string): Promise<{ id: string; viewingKey: string }> {
    const viewingKey = await getWalletShareableViewingKey(this.walletId)
    if (!viewingKey) throw new Error('The fee viewing identity is unavailable.')
    const wallet = await createViewOnlyRailgunWallet(encryptionKey, viewingKey, undefined)
    viewOnlyWalletForID(wallet.id)
    if (wallet.railgunAddress !== this.address) throw new Error('Fee-wallet migration changed its address.')
    return { id: wallet.id, viewingKey }
  }

  ready(): boolean { return this.started && !!this.address && this.utxoReady }
  async balances(): Promise<Record<string, string>> {
    if (!this.ready()) throw new Error('Private fee history is not synchronized.')
    return Object.fromEntries(await Promise.all(TOKENS.map(async (token) => [getAddress(token.address),
      String(await balanceForERC20Token(VERSION, walletForID(this.walletId), NETWORK_NAME, token.address, true))])))
  }
  async sign(message: string): Promise<string> { return signWithWalletViewingKey(this.walletId, message) }

  async fee(request: ParsedRequest): Promise<Record<string, bigint>> {
    // Count only the first fee note: the SDK exposes assurance data for transaction zero.
    const amounts = await walletForID(this.walletId).extractFirstNoteERC20AmountMap(VERSION, NETWORK.chain,
      { to: NETWORK.proxyContract, data: PROXY.encodeFunctionData('transact', [[request.transactions[0]]]) },
      false, NETWORK.proxyContract, false)
    return Object.fromEntries(Object.entries(amounts).map(([token, amount]) => {
      if (typeof amount !== 'bigint') throw new Error('Unexpected SDK fee amount.')
      return [getAddress(parseRailgunTokenAddress(token)), amount]
    }))
  }
  async validate(request: ParsedRequest): Promise<FeeProof> {
    if (POI.getActiveListKeys().length) throw new Error('The Ophis wallet policy is not initialized.')
    const pois: PreTransactionPOIsPerTxidLeafPerList = {}
    // SDK convenience wrappers use the delegate address; 7702 calls target the validated ephemeral account.
    const result = await walletForID(this.walletId).isValidSpendableTransaction(VERSION, NETWORK.chain,
      String(request.transaction.to), request.transaction, request.type4, pois, request.type4)
    if (!result.isValid) throw new Error('The private fee transaction could not be decoded.')
    const fee = result.extractedRailgunTransactionData?.[0]
    if (!fee?.firstCommitment || fee.firstCommitment !== request.transactions[0].commitments[0] ||
      !fee.firstCommitmentNotePublicKey) throw new Error('No validated broadcaster fee commitment.')
    return { railgunTxid: fee.railgunTxid, utxoTreeIn: Number(fee.utxoTreeIn), commitment: fee.firstCommitment,
      notePublicKey: ByteUtils.nToHex(fee.firstCommitmentNotePublicKey, ByteLength.UINT_256, true), pois }
  }
  async assure(txHash: string, proof: FeeProof): Promise<boolean> {
    await refreshBalances(NETWORK.chain, [this.walletId])
    const notes = await walletForID(this.walletId).TXOs(VERSION, NETWORK.chain)
    return notes.some((note) =>
      ByteUtils.formatToByteLength(note.txid, ByteLength.UINT_256, true).toLowerCase() === txHash.toLowerCase() &&
      ByteUtils.nToHex(note.note.hash, ByteLength.UINT_256, true).toLowerCase() === proof.commitment.toLowerCase())
  }
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    try { await stopRailgunEngine() } finally { if (this.providerLoaded) await unloadProvider(NETWORK_NAME); this.providerLoaded = false }
  }
}
