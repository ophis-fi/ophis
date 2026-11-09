import { ByteLength, ByteUtils, type Commitment, type TXO } from '@railgun-community/engine'
import { getAddress, isHexString } from 'ethers'
import { getRailgunWalletAddressData } from '@railgun-community/wallet'
import type { JsonRpcProvider, TransactionReceipt } from 'ethers'
import { CHAIN, NETWORK } from './config'
import type { CreditScope } from '../../railgun/credit-protocol'
import { PROXY } from './transaction'
import { finalizedCreditEvidence, finalizedCreditReceipt, verifyReceivedCredit } from './credit-payment'

/** Position is essential: identical note commitments can be inserted at different positions. */
export interface AccountedNote {
  tree: number; position: number; commitment: string; transactionHash: string; blockNumber: number; blockHash: string; amount: string
}
export const noteIdentity = (note: Pick<AccountedNote, 'tree' | 'position' | 'commitment'>): string =>
  `${note.tree}:${note.position}:${note.commitment.toLowerCase()}`
export const noteHash = (note: TXO): string => ByteUtils.nToHex(note.note.hash, ByteLength.UINT_256, true).toLowerCase()
export const txHash = (hash: string): string => ByteUtils.formatToByteLength(hash, ByteLength.UINT_256, true).toLowerCase()

interface DebitDetails {
  transactionHash: string; blockHash: string; blockNumber: number; debit: bigint
  nullifiers: readonly string[]; inputs: readonly AccountedNote[]; change: readonly AccountedNote[]
}
export interface VerifiedOwnerDebit { readonly kind: 'verified-owner-debit' }
const verified = new WeakMap<VerifiedOwnerDebit, Readonly<DebitDetails>>()
export function ownerDebitEvidence(proof: VerifiedOwnerDebit): Readonly<DebitDetails> {
  const evidence = verified.get(proof)
  if (!evidence) throw new Error('Canonical owned-input debit evidence is required.')
  return evidence
}

export interface VerifiedUnrelatedOwnerPayout { readonly kind: 'verified-unrelated-owner-payout' }
const unrelated = new WeakMap<VerifiedUnrelatedOwnerPayout, Readonly<{
  transactionHash: string; blockNumber: number; blockHash: string; scope: string; accounted: string; logs: string; checkedAt: number
}>>()
const scopeIdentity = (scope: CreditScope): string => JSON.stringify([scope.chainId, getAddress(scope.operator), scope.recipient, getAddress(scope.token)])
const accountedIdentity = (notes: readonly AccountedNote[]): string => JSON.stringify(notes.map((note) =>
  [noteIdentity(note), note.amount, note.transactionHash.toLowerCase(), note.blockNumber, note.blockHash.toLowerCase()]).sort())
function unrelatedReceiptLogs(receipt: TransactionReceipt): string {
  const canonical = finalizedCreditEvidence(receipt)
  if (receipt.status !== 1 || canonical.status !== 1 || receipt.hash !== canonical.hash || receipt.blockHash !== canonical.blockHash ||
    receipt.blockNumber !== canonical.blockNumber || !Array.isArray(receipt.logs) || receipt.logs.length > 1024)
    throw new Error('The unrelated payout receipt changed canonical evidence.')
  const indexes = new Set<number>(); let bytes = 0
  return JSON.stringify(receipt.logs.map((log) => {
    if (log.removed || log.transactionHash !== canonical.hash || log.blockHash !== canonical.blockHash || log.blockNumber !== canonical.blockNumber ||
      !Number.isSafeInteger(log.index) || log.index < 0 || indexes.has(log.index) || !isHexString(log.data) || log.data.length > 524_290 ||
      !Array.isArray(log.topics) || log.topics.length > 8 || log.topics.some((topic: unknown) => !isHexString(topic, 32)))
      throw new Error('The unrelated payout has invalid or unbounded canonical logs.')
    indexes.add(log.index); bytes += log.data.length + 66 * log.topics.length
    if (bytes > 4 * 1024 * 1024) throw new Error('The unrelated payout log snapshot exceeds its bound.')
    return [getAddress(log.address), log.index, log.data.toLowerCase(), log.topics.map((topic: string) => topic.toLowerCase())]
  }))
}

/** Only the synchronized view-wallet adapter supplies the complete TXO scan. Never ignore unclaimed wallet inputs. */
export async function verifyUnrelatedOwnerPayout(provider: JsonRpcProvider, receipt: TransactionReceipt,
  scope: CreditScope, notes: readonly TXO[], accounted: readonly AccountedNote[]): Promise<VerifiedUnrelatedOwnerPayout> {
  const canonical = finalizedCreditEvidence(receipt), started = Date.now()
  if (scope.chainId !== Number(CHAIN) || canonical.status !== 1 || !Array.isArray(receipt.logs) || receipt.logs.length > 1024)
    throw new Error('An unchanged successful finalized payout and complete wallet scan are required.')
  const logs = unrelatedReceiptLogs(receipt)
  const recipient = getRailgunWalletAddressData(scope.recipient), owned = new Set<string>(), scanned = new Set<string>()
  for (const note of notes) {
    if (note.note.receiverAddressData.masterPublicKey !== recipient.masterPublicKey ||
      !Buffer.from(note.note.receiverAddressData.viewingPublicKey).equals(Buffer.from(recipient.viewingPublicKey)))
      throw new Error('Unrelated payout evidence must use the exact fee wallet scan.')
    owned.add(`${note.tree}:${txHash(note.nullifier)}`)
    scanned.add(noteIdentity({ tree: note.tree, position: note.position, commitment: noteHash(note) }))
  }
  if (accounted.some((note) => !scanned.has(noteIdentity(note))))
    throw new Error('Incomplete fee-wallet history cannot dismiss a payout candidate.')
  const observed: string[] = []
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(NETWORK.proxyContract)) continue
    if (log.removed || log.transactionHash !== canonical.hash || log.blockHash !== canonical.blockHash || log.blockNumber !== canonical.blockNumber)
      throw new Error('The owner payout logs changed canonical evidence.')
    const event = PROXY.parseLog(log)
    if (event?.name !== 'Nullified') continue
    for (const nullifier of event.args.nullifier) {
      const identity = `${event.args.treeNumber}:${txHash(String(nullifier))}`
      if (owned.has(identity)) throw new Error('The candidate spent a fee-wallet input and must remain held.')
      observed.push(identity)
    }
  }
  if (!observed.length || observed.length > 1024 || new Set(observed).size !== observed.length)
    throw new Error('A bounded canonical unrelated private spend is required.')
  const currentReceipt = await finalizedCreditReceipt(provider, canonical.hash), current = finalizedCreditEvidence(currentReceipt)
  const latest = await provider.getBlock('latest')
  if (current.blockHash !== canonical.blockHash || current.blockNumber !== canonical.blockNumber || current.status !== 1 ||
    unrelatedReceiptLogs(currentReceipt) !== logs || !latest ||
    Math.abs(Date.now() / 1000 - latest.timestamp) > 45 || Date.now() - started > 40_000)
    throw new Error('Unrelated owner payout evidence changed or expired.')
  const proof: VerifiedUnrelatedOwnerPayout = Object.freeze({ kind: 'verified-unrelated-owner-payout' })
  unrelated.set(proof, Object.freeze({ transactionHash: canonical.hash, blockHash: canonical.blockHash, blockNumber: canonical.blockNumber,
    scope: scopeIdentity(scope), accounted: accountedIdentity(accounted), logs, checkedAt: Date.now() }))
  return proof
}

export function assertUnrelatedOwnerPayout(proof: VerifiedUnrelatedOwnerPayout, receipt: TransactionReceipt,
  scope: CreditScope, accounted: readonly AccountedNote[]): void {
  const evidence = unrelated.get(proof), canonical = finalizedCreditEvidence(receipt)
  if (!evidence || evidence.transactionHash !== canonical.hash || evidence.blockHash !== canonical.blockHash ||
    evidence.blockNumber !== canonical.blockNumber || evidence.scope !== scopeIdentity(scope) || evidence.accounted !== accountedIdentity(accounted) ||
    evidence.logs !== unrelatedReceiptLogs(receipt) ||
    Date.now() - evidence.checkedAt > 45_000 || evidence.checkedAt > Date.now())
    throw new Error('Fresh complete-wallet evidence that this candidate spent no fee-wallet inputs is required.')
}

/** Exact note debit, not a balance delta: concurrent incoming funds cannot conceal an owner fee. */
export async function verifyOwnedFeeDebit(provider: JsonRpcProvider, receipt: TransactionReceipt,
  scope: { recipient: string; token: string }, notes: readonly TXO[], accounted: readonly AccountedNote[],
  maximumInputs: number, maximumOutputs: number, maximumProofs: number,
  commitmentAt: (tree: number, position: number) => Promise<Commitment>): Promise<VerifiedOwnerDebit> {
  const canonical = finalizedCreditEvidence(receipt)
  if (canonical.status !== 1 || !Number.isSafeInteger(maximumInputs) || maximumInputs < 1 || maximumInputs > 2 ||
    !Number.isSafeInteger(maximumOutputs) || maximumOutputs < 1 || maximumOutputs > 4 ||
    !Number.isSafeInteger(maximumProofs) || maximumProofs < 1 || maximumProofs > 2)
    throw new Error('Owner debit requires a qualified bounded proof shape.')
  const known = new Map(accounted.map((note) => [noteIdentity(note), note]))
  const inputs = notes.filter((note) => note.spendtxid && txHash(note.spendtxid) === canonical.hash.toLowerCase())
  if (!inputs.length || inputs.length > maximumInputs || new Set(inputs.map((note) => note.tree)).size !== 1)
    throw new Error('Owner payment exceeds the qualified single-tree input limit.')
  const nullifiers = inputs.map((note) => txHash(note.nullifier)).sort()
  if (new Set(nullifiers).size !== inputs.length) throw new Error('Duplicate owner input nullifier.')
  const observed: string[] = []
  let proofs = 0, outputsCount = 0
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(NETWORK.proxyContract)) continue
    if (log.removed || log.transactionHash !== canonical.hash || log.blockHash !== canonical.blockHash || log.blockNumber !== canonical.blockNumber)
      throw new Error('Owner payment contains inconsistent pool logs.')
    const event = PROXY.parseLog(log)
    if (event?.name === 'Transact') outputsCount += event.args.hash.length
    if (event?.name === 'Unshield') outputsCount++
    if (event?.name !== 'Nullified') continue
    proofs++
    if (Number(event.args.treeNumber) !== inputs[0].tree) throw new Error('Owner payment spent another input tree.')
    observed.push(...Array.from(event.args.nullifier, (value) => txHash(String(value))))
  }
  if (JSON.stringify(observed.sort()) !== JSON.stringify(nullifiers))
    throw new Error('Every canonical spent nullifier must belong to an accounted fee note.')
  if (proofs > maximumProofs || outputsCount > maximumOutputs)
    throw new Error('Owner payment exceeds the qualified proof and output limits.')
  let spent = 0n
  const provenance: AccountedNote[] = []
  for (const input of inputs) {
    const identity = { tree: input.tree, position: input.position, commitment: noteHash(input) }
    const saved = known.get(noteIdentity(identity))
    if (!saved || saved.transactionHash.toLowerCase() !== txHash(input.txid) || saved.blockNumber !== input.blockNumber || saved.amount !== input.note.value.toString())
      throw new Error('Unclaimed incoming notes cannot fund an accounted owner operation.')
    const origin = await finalizedCreditReceipt(provider, saved.transactionHash)
    if (origin.blockHash !== saved.blockHash || origin.blockNumber !== saved.blockNumber)
      throw new Error('An accounted owner input changed canonical history.')
    spent += verifyReceivedCredit(origin, input, await commitmentAt(input.tree, input.position),
      { recipient: scope.recipient, token: scope.token, memo: input.note.memoText })
    provenance.push({ ...saved })
  }
  const outputs = notes.filter((note) => txHash(note.txid) === canonical.hash.toLowerCase())
  // One change note cannot fragment previously collectible value; arbitrary splits can lower top-N by more than the debit.
  if (outputs.length > 1) throw new Error('Owner change exceeds the qualified single-change shape.')
  let returned = 0n
  const change: AccountedNote[] = []
  for (const output of outputs) {
    returned += verifyReceivedCredit(receipt, output, await commitmentAt(output.tree, output.position),
      { recipient: scope.recipient, token: scope.token, memo: output.note.memoText })
    change.push({ tree: output.tree, position: output.position, commitment: noteHash(output),
      transactionHash: canonical.hash, blockNumber: canonical.blockNumber, blockHash: canonical.blockHash, amount: output.note.value.toString() })
  }
  if (spent <= returned) throw new Error('Owner payment must have an exact positive private debit.')
  const proof: VerifiedOwnerDebit = Object.freeze({ kind: 'verified-owner-debit' })
  verified.set(proof, Object.freeze({ transactionHash: canonical.hash, blockHash: canonical.blockHash, blockNumber: canonical.blockNumber,
    debit: spent - returned, nullifiers: Object.freeze(nullifiers), inputs: Object.freeze(provenance.map((value) => Object.freeze(value))),
    change: Object.freeze(change.map((value) => Object.freeze(value))) }))
  return proof
}
