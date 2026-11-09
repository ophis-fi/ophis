import { CommitmentType, OutputType, TransactNote, type TXO, type TransactCommitmentV2 } from '@railgun-community/engine'
import { getRailgunWalletAddressData } from '@railgun-community/wallet'
import { id, Wallet, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { CHAIN, NETWORK, TOKENS } from '../src/config'
import { PROXY } from '../src/transaction'
import { finalizedCreditReceipt } from '../src/credit-payment'
import { noteHash, verifyOwnedFeeDebit, type AccountedNote } from '../src/credit-owner-payment'
import { verifyCreditBacking } from '../src/credit-backing'
import type { CreditLedger } from '../src/credit'

export const feeAddress = '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
export const external = Wallet.createRandom().address
export const blockHash = (number: number) => id(`owner-unit-block-${number}`)
export function syntheticNote(amount: bigint, position: number, blockNumber = 10, tree = 0, txid = id(`owner-unit-deposit-${position}`)): TXO {
  return { tree, position, txid, blockNumber, timestamp: Math.floor(Date.now() / 1000), spendtxid: false,
    nullifier: id(`owner-unit-nullifier-${tree}-${position}`), commitmentType: CommitmentType.TransactCommitmentV2,
    note: TransactNote.createTransfer(getRailgunWalletAddressData(feeAddress), undefined, amount,
      { tokenType: 0, tokenAddress: TOKENS[0].address, tokenSubID: '0' }, false, OutputType.Transfer, undefined),
  } as TXO
}
// This fixture tests canonical note/ciphertext binding, not encryption or SNARK validity; real encrypted scans have separate tests.
export function commitmentFor(note: TXO): TransactCommitmentV2 {
  return { commitmentType: CommitmentType.TransactCommitmentV2, hash: noteHash(note), txid: note.txid,
    blockNumber: note.blockNumber, utxoTree: note.tree, utxoIndex: note.position,
    ciphertext: { ciphertext: { iv: '11'.repeat(16), tag: '22'.repeat(16), data: ['33'.repeat(32), '44'.repeat(32), '55'.repeat(32)] },
      blindedSenderViewingKey: '66'.repeat(32), blindedReceiverViewingKey: '77'.repeat(32), annotationData: '0x', memo: '0x' },
  } as TransactCommitmentV2
}
export function receiptFor(txid: string, blockNumber: number, outputs: TXO[], inputs: TXO[] = []): TransactionReceipt {
  const events = outputs.map((note) => {
    const c = commitmentFor(note).ciphertext
    return PROXY.encodeEventLog(PROXY.getEvent('Transact')!, [note.tree, note.position, [noteHash(note)], [{
      ciphertext: [`0x${c.ciphertext.iv}${c.ciphertext.tag}`, ...c.ciphertext.data.map((s) => `0x${s}`)],
      blindedSenderViewingKey: `0x${c.blindedSenderViewingKey}`, blindedReceiverViewingKey: `0x${c.blindedReceiverViewingKey}`,
      annotationData: '0x', memo: '0x',
    }]])
  })
  if (inputs.length) events.push(PROXY.encodeEventLog(PROXY.getEvent('Nullified')!, [inputs[0].tree, inputs.map((n) => n.nullifier)]))
  return { hash: txid, blockNumber, blockHash: blockHash(blockNumber), gasUsed: 10n, gasPrice: 1n, status: 1,
    from: external, to: NETWORK.proxyContract,
    logs: events.map((event, index) => ({ ...event, index, address: NETWORK.proxyContract, removed: false,
      transactionHash: txid, blockNumber, blockHash: blockHash(blockNumber) })),
  } as unknown as TransactionReceipt
}
export function provenance(note: TXO): AccountedNote {
  return { tree: note.tree, position: note.position, commitment: noteHash(note), amount: note.note.value.toString(),
    transactionHash: note.txid, blockNumber: note.blockNumber, blockHash: blockHash(note.blockNumber) }
}
export function chainFixture() {
  const receipts = new Map<string, TransactionReceipt>(), commitments = new Map<string, TransactCommitmentV2>()
  const notes = new Map<string, TXO>()
  const provider = { getNetwork: async () => ({ chainId: CHAIN }),
    getBlock: async (tag: string | number) => {
      const number = typeof tag === 'number' ? tag : 100
      return { number, hash: blockHash(number), timestamp: Math.floor(Date.now() / 1000) }
    },
    getTransactionReceipt: async (hash: string) => receipts.get(hash) ?? null,
    call: async () => PROXY.encodeFunctionResult('nullifiers', [false]),
  } as unknown as JsonRpcProvider
  const add = (note: TXO) => {
    notes.set(`${note.tree}:${note.position}`, note)
    commitments.set(`${note.tree}:${note.position}`, commitmentFor(note))
    receipts.set(note.txid, receiptFor(note.txid, note.blockNumber, [note]))
  }
  return { provider, receipts, commitments, notes, add }
}
export async function ownerEvidence(chain: ReturnType<typeof chainFixture>, ledger: CreditLedger, inputs: TXO[], outputs: TXO[],
  receipt: TransactionReceipt, untouched: TXO[] = []) {
  for (const output of outputs) chain.commitments.set(`${output.tree}:${output.position}`, commitmentFor(output))
  chain.receipts.set(receipt.hash, receipt)
  const canonical = await finalizedCreditReceipt(chain.provider, receipt.hash)
  const spent = inputs.map((note) => ({ ...note, spendtxid: receipt.hash }))
  const notes = [...spent, ...outputs, ...untouched]
  for (const note of notes) chain.notes.set(`${note.tree}:${note.position}`, note)
  const debit = await verifyOwnedFeeDebit(chain.provider, canonical, ledger.scope, notes, ledger.accountedNotes(), 2, 4, 2,
    async (tree, position) => chain.commitments.get(`${tree}:${position}`)!)
  const backing = await verifyCreditBacking(chain.provider, notes, [...ledger.accountedNotes(), ...outputs.map(provenance)], 2)
  return { receipt: canonical, debit, backing }
}
