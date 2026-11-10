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
import { ByteUtils, ByteLength, OutputType, POI } from '@railgun-community/engine'
import { MerkletreeScanStatus,
  type PreTransactionPOIsPerTxidLeafPerList } from '@railgun-community/shared-models'
import { getAddress, JsonRpcProvider } from 'ethers'
import { CHAIN_ID, NETWORK, NETWORK_NAME, TOKENS, VERSION, type Settings } from './config'
import { assertDisk, privateDirectory, type Secrets, type Store } from './storage'
import { PROXY, type ParsedRequest } from './transaction'
import { disablePPOI } from '../../railgun/poi-policy'
import { creditMemo, creditRefundMemo, type CreditScope } from '../../railgun/credit-protocol'
import { finalizedCreditReceipt, verifyReceivedCredit } from './credit-payment'
import type { ConfirmedCredit, ConfirmedRefund, RefundPayout, OwnerIntent, ConfirmedCollection } from './credit'
import { verifyCreditBacking, type CreditBacking } from './credit-backing'
import { verifyOwnedFeeDebit, verifyUnrelatedOwnerPayout, ownerDebitEvidence, type AccountedNote } from './credit-owner-payment'
import { verifyAnonNativeCollection, assertExternalOwnerTransaction } from './anon-native-collection'

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
  private creditRefresh?: Promise<void>
  private creditRefreshedAt = 0
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
  private async refreshCreditBalances(): Promise<void> {
    if (this.creditRefresh) return this.creditRefresh
    if (Date.now() - this.creditRefreshedAt < 5_000) return
    this.creditRefresh = refreshBalances(NETWORK.chain, [this.walletId]).then(() => {
      if (this.ready()) this.creditRefreshedAt = Date.now()
    }).finally(() => { this.creditRefresh = undefined })
    return this.creditRefresh
  }
  async accountedCreditBacking(provider: JsonRpcProvider, accounted: readonly AccountedNote[], maximumInputs: number): Promise<CreditBacking> {
    if (!this.ready()) throw new Error('Private fee history must be synchronized.')
    await this.refreshCreditBalances()
    if (!this.ready()) throw new Error('Accounted backing requires a completed wallet scan.')
    return verifyCreditBacking(provider, await walletForID(this.walletId).TXOs(VERSION, NETWORK.chain), accounted, maximumInputs)
  }

  async unrelatedOwnerPayout(provider: JsonRpcProvider, scope: CreditScope, accounted: readonly AccountedNote[], transactionHash: string) {
    if (!this.ready() || scope.recipient !== this.address || scope.chainId !== CHAIN_ID)
      throw new Error('The synchronized fee wallet must match the saved payout scope.')
    await refreshBalances(NETWORK.chain, [this.walletId])
    if (!this.ready()) throw new Error('A complete fee-wallet scan is required to reject an unrelated private payout.')
    const receipt = await finalizedCreditReceipt(provider, transactionHash)
    const proof = await verifyUnrelatedOwnerPayout(provider, receipt, scope,
      await walletForID(this.walletId).TXOs(VERSION, NETWORK.chain), accounted)
    if (!this.ready()) throw new Error('Fee-wallet synchronization changed during payout verification.')
    return { receipt, proof }
  }

  async confirmedCredits(provider: JsonRpcProvider, scope: CreditScope, ledgerId: string, owner: string, txHash: string): Promise<ConfirmedCredit[]> {
    if (!this.ready() || scope.recipient !== this.address || scope.chainId !== CHAIN_ID)
      throw new Error('The confirmed credit wallet is not ready or does not match its ledger.')
    const receipt = await finalizedCreditReceipt(provider, txHash)
    if (receipt.status !== 1) throw new Error('The private top-up transaction failed.')
    if (!Array.isArray(receipt.logs) || receipt.logs.length > 1024 || !receipt.logs.some((log) =>
      getAddress(log.address) === getAddress(NETWORK.proxyContract) && !log.removed && log.transactionHash === receipt.hash &&
      log.blockNumber === receipt.blockNumber && log.blockHash === receipt.blockHash && PROXY.parseLog(log)?.name === 'Transact'))
      throw new Error('No canonical private transfer output exists in this top-up transaction.')
    await this.refreshCreditBalances()
    if (!this.ready()) throw new Error('Credit verification requires a completed wallet scan.')
    const wallet = walletForID(this.walletId), memo = creditMemo(scope, ledgerId, owner)
    const notes = (await wallet.TXOs(VERSION, NETWORK.chain)).filter((txo) =>
      ByteUtils.formatToByteLength(txo.txid, ByteLength.UINT_256, true).toLowerCase() === receipt.hash.toLowerCase() && txo.note.memoText === memo)
    const payments: ConfirmedCredit[] = []
    for (const txo of notes) {
      try {
        const commitment = await wallet.getUTXOMerkletree(VERSION, NETWORK.chain).getCommitment(txo.tree, txo.position)
        const amount = verifyReceivedCredit(receipt, txo, commitment, { token: scope.token, recipient: scope.recipient, memo })
        payments.push({ owner: getAddress(owner), amount, tree: txo.tree, position: txo.position,
          commitment: ByteUtils.nToHex(txo.note.hash, ByteLength.UINT_256, true),
          transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash })
      } catch { /* A mismatched output must not hide another independently verified credit in the same transaction. */ }
    }
    if (!payments.length) throw new Error('No finalized private payment for this credit owner was found. Wait for wallet synchronization.')
    return payments
  }
  async confirmedRefund(provider: JsonRpcProvider, scope: CreditScope, ledgerId: string, key: string,
    recipient: string, amount: bigint, ownerPayouts: readonly RefundPayout[] = [],
    commitmentAvailable: (commitment: string) => boolean = () => true,
    ownerOperation?: { intent: OwnerIntent; accounted: readonly AccountedNote[] }): Promise<ConfirmedRefund> {
    if (!this.ready() || scope.recipient !== this.address || scope.chainId !== CHAIN_ID)
      throw new Error('The refund viewing identity is unavailable.')
    // Sender-view annotations are not proof of spending authority; require the owner's explicit payout association.
    if (!ownerPayouts.length) throw new Error('The owner must associate the finalized payout before refund verification.')
    await refreshBalances(NETWORK.chain, [this.walletId])
    if (!this.ready()) throw new Error('Refund verification requires a completed wallet scan.')
    const wallet = walletForID(this.walletId), memo = creditRefundMemo(scope, ledgerId, key)
    const { sentCommitments } = await wallet.getSentCommitmentsAndUnshieldEventsNeedPOIs(VERSION, NETWORK.chain)
    for (const sent of sentCommitments) {
      const transactionHash = ByteUtils.formatToByteLength(sent.txid, ByteLength.UINT_256, true)
      const assigned = ownerPayouts.find((payout) => payout.transaction_hash === transactionHash)
      const commitmentHash = ByteUtils.nToHex(sent.note.hash, ByteLength.UINT_256, true)
      const matchingMemo = sent.note.memoText === memo
      const assignedWithoutMemo = assigned && (sent.note.memoText === undefined || sent.note.memoText === '')
      if (sent.isLegacyTransactNote || sent.outputType !== OutputType.Transfer ||
        !assigned || (!matchingMemo && !assignedWithoutMemo) || sent.note.value !== amount || !commitmentAvailable(commitmentHash)) continue
      try {
        const receipt = await finalizedCreditReceipt(provider, transactionHash)
        if (receipt.status !== 1 || assigned.block_hash !== receipt.blockHash || assigned.block_number !== receipt.blockNumber) continue
        const commitment = await wallet.getUTXOMerkletree(VERSION, NETWORK.chain).getCommitment(sent.tree, sent.position)
        verifyReceivedCredit(receipt, { ...sent, blockNumber: receipt.blockNumber }, commitment,
          { recipient, token: scope.token, memo: sent.note.memoText })
        const payment: ConfirmedRefund = { receipt, recipient, amount, token: scope.token, memo: sent.note.memoText, commitment: commitmentHash }
        if (ownerOperation) {
          const { intent, accounted } = ownerOperation
          if (intent.kind !== 'refund' || intent.refund_key !== key || intent.ledger_id !== ledgerId)
            throw new Error('The owner refund intent does not match this payment.')
          await assertExternalOwnerTransaction(provider, receipt, scope.operator)
          const notes = await wallet.TXOs(VERSION, NETWORK.chain)
          payment.debit = await verifyOwnedFeeDebit(provider, receipt, scope, notes, accounted, intent.input_limit,
            intent.output_limit, intent.proof_limit, (tree, position) => wallet.getUTXOMerkletree(VERSION, NETWORK.chain).getCommitment(tree, position))
          payment.backing = await verifyCreditBacking(provider, notes, [...accounted, ...ownerDebitEvidence(payment.debit).change], intent.input_limit)
        }
        return payment
      } catch { /* A wrong or unfinalized candidate must not hide a later verified payout. */ }
    }
    throw new Error('The exact finalized outgoing refund has not been found.')
  }

  async confirmedOwnerCollection(provider: JsonRpcProvider, scope: CreditScope, intent: OwnerIntent,
    accounted: readonly AccountedNote[], candidate: RefundPayout): Promise<ConfirmedCollection> {
    if (!this.ready() || scope.recipient !== this.address || scope.chainId !== CHAIN_ID || intent.kind !== 'collection')
      throw new Error('The owner collection viewing identity is unavailable.')
    const receipt = await finalizedCreditReceipt(provider, candidate.transaction_hash)
    if (receipt.blockHash !== candidate.block_hash || receipt.blockNumber !== candidate.block_number)
      throw new Error('The owner collection changed canonical evidence.')
    await refreshBalances(NETWORK.chain, [this.walletId])
    if (!this.ready()) throw new Error('Owner collection requires a completed wallet scan.')
    const wallet = walletForID(this.walletId), notes = await wallet.TXOs(VERSION, NETWORK.chain)
    const debit = await verifyOwnedFeeDebit(provider, receipt, scope, notes, accounted, intent.input_limit,
      intent.output_limit, intent.proof_limit, (tree, position) => wallet.getUTXOMerkletree(VERSION, NETWORK.chain).getCommitment(tree, position))
    const evidence = ownerDebitEvidence(debit)
    const native = await verifyAnonNativeCollection(provider, receipt, { operator: scope.operator, token: scope.token,
      nullifiers: evidence.nullifiers, maximumInputs: intent.input_limit, maximumOutputs: intent.output_limit,
      maximumProofs: intent.proof_limit, minimumNative: BigInt(intent.minimum_native) })
    const backing = await verifyCreditBacking(provider, notes, [...accounted, ...evidence.change], intent.input_limit)
    return { debit, native, backing }
  }

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
  async validatePrepaid(request: ParsedRequest): Promise<void> {
    if (POI.getActiveListKeys().length) throw new Error('The Ophis wallet policy is not initialized.')
    const [withdrawal] = request.transactions
    // A full unshield has no fee ciphertext; its spend proof is checked by the broadcaster's exact contract trace.
    if ((!request.type4 || request.withdrawal) && request.transactions.length === 1 &&
      BigInt(withdrawal.boundParams.unshield) === 1n && withdrawal.commitments.length === 1 &&
      withdrawal.boundParams.commitmentCiphertext.length === 0 && withdrawal.nullifiers.length > 0 &&
      withdrawal.nullifiers.every((nullifier) => typeof nullifier === 'string' && BigInt(nullifier) !== 0n)) return
    const result = await walletForID(this.walletId).isValidSpendableTransaction(VERSION, NETWORK.chain,
      String(request.transaction.to), request.transaction, request.type4, {}, request.type4)
    if (!result.isValid || result.extractedRailgunTransactionData?.length !== request.transactions.length)
      throw new Error('The prepaid private transaction could not be decoded.')
    if (result.extractedRailgunTransactionData.some((tx) => tx.firstCommitmentNotePublicKey !== undefined))
      throw new Error('Prepaid execution must not also send an embedded broadcaster fee.')
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
