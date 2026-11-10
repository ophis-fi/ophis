import type { TXO } from '@railgun-community/engine'
import { getAddress, type JsonRpcProvider } from 'ethers'
import { parseRailgunTokenAddress } from '@railgun-community/wallet'
import { CHAIN, TOKENS } from './config'
import { noteHash, noteIdentity, txHash, type AccountedNote } from './credit-owner-payment'
import { backingRead, finalizedBackingHead, unspentBackingHead } from './credit-nullifier-checkpoint'

export interface CreditBacking { readonly kind: 'verified-credit-backing' }
interface Details { available: bigint; bounded: bigint; maximumInputs: number; checkedAt: number }
const observations = new WeakMap<CreditBacking, Readonly<Details>>()
export function creditBackingEvidence(proof: CreditBacking): Readonly<Details> {
  const value = observations.get(proof)
  if (!value || Date.now() - value.checkedAt > 45_000 || value.checkedAt > Date.now())
    throw new Error('Fresh canonical accounted-note backing is required.')
  return value
}

/** No donations or unclaimed top-ups: only exact journaled positions may secure operator spending. */
export async function verifyCreditBacking(provider: JsonRpcProvider, notes: readonly TXO[],
  accounted: readonly AccountedNote[], maximumInputs: number): Promise<CreditBacking> {
  if ((await backingRead(provider.getNetwork())).chainId !== CHAIN || !Number.isSafeInteger(maximumInputs) || maximumInputs < 1 || maximumInputs > 2)
    throw new Error('A qualified collection input limit is required.')
  const finalized = await finalizedBackingHead(provider)
  const known = new Map(accounted.map((note) => [noteIdentity(note), note])), seen = new Set<string>()
  const eligible: { note: TXO; saved: AccountedNote }[] = []
  let available = 0n, bounded = 0n
  for (const note of notes) {
    const identity = noteIdentity({ tree: note.tree, position: note.position, commitment: noteHash(note) })
    const saved = known.get(identity)
    if (!saved || note.spendtxid || note.blockNumber > finalized.number) continue
    if (seen.has(identity)) throw new Error('Duplicate private note scan evidence.')
    seen.add(identity)
    if (saved.transactionHash.toLowerCase() !== txHash(note.txid) || saved.blockNumber !== note.blockNumber ||
      saved.amount !== note.note.value.toString() || note.note.value <= 0n || note.note.tokenData.tokenType !== 0 ||
      BigInt(note.note.tokenData.tokenSubID) !== 0n || getAddress(parseRailgunTokenAddress(note.note.tokenData.tokenAddress)) !== TOKENS[0].address)
      throw new Error('Accounted fee-note provenance changed.')
    eligible.push({ note, saved })
  }
  const latest = await unspentBackingHead(provider, eligible.map(({ note, saved }) => ({
    key: JSON.stringify([noteIdentity(saved), saved.amount, saved.transactionHash.toLowerCase(), saved.blockNumber,
      saved.blockHash.toLowerCase(), txHash(note.nullifier), TOKENS[0].address]),
    tree: note.tree, nullifier: txHash(note.nullifier), blockNumber: saved.blockNumber, blockHash: saved.blockHash,
  })), finalized)
  for (const { note } of eligible) {
    available += note.note.value
    // A single large note survives output-tree rollover: if spent, its one change note carries the residual capacity.
    // Summing two old-tree notes could strand the remainder when change is created in a new tree.
    if (note.note.value > bounded) bounded = note.note.value
  }
  const proof: CreditBacking = Object.freeze({ kind: 'verified-credit-backing' })
  observations.set(proof, Object.freeze({ available, bounded, maximumInputs, checkedAt: Math.min(Date.now(), latest.timestamp * 1000) }))
  return proof
}
