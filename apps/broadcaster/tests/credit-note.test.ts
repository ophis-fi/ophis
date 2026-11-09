import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import LevelDOWN from 'leveldown'
import { id, Wallet, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { ByteLength, ByteUtils, CommitmentType, Database, OutputType, RailgunEngine, RailgunWallet, TransactNote,
  TokenType, ViewOnlyWallet, type AbstractWallet, type Chain, type TransactCommitmentV2 } from '@railgun-community/engine'
import { getRailgunWalletAddressData } from '@railgun-community/wallet'
import { creditMemo, creditRefundMemo } from '../../railgun/credit-protocol'
import { verifyReceivedCredit } from '../src/credit-payment'
import { CHAIN_ID, NETWORK, TOKENS, VERSION } from '../src/config'
import { PROXY } from '../src/transaction'
import { RailgunSDK } from '../src/sdk'
import { config } from './request.fixture'
import type { Secrets, Store } from '../src/storage'

vi.mock('@railgun-community/wallet', async (original) => ({ ...await original<typeof import('@railgun-community/wallet')>(),
  walletForID: () => feeView, refreshBalances: async () => undefined }))

// The pinned engine does not export these constructors/helpers at its package root.
// Only fixture construction uses deep imports; wallet scanning and note reads use public APIs.
const require = createRequire(import.meta.url)
const engineRoot = dirname(require.resolve('@railgun-community/engine'))
type Tree = ReturnType<AbstractWallet['getUTXOMerkletree']>
const { UTXOMerkletree } = require(join(engineRoot, 'merkletree/utxo-merkletree.js')) as {
  UTXOMerkletree: { create(db: Database, chain: Chain, version: typeof VERSION,
    validateRoot: () => Promise<boolean>): Promise<Tree> }
}
const { getNoteBlindingKeys, getSharedSymmetricKey } = require(join(engineRoot, 'utils/keys-utils.js')) as {
  getNoteBlindingKeys(sender: Uint8Array, recipient: Uint8Array, random: string, senderRandom: string): {
    blindedSenderViewingKey: Uint8Array; blindedReceiverViewingKey: Uint8Array
  }
  getSharedSymmetricKey(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array | undefined>
}

const token = TOKENS[0].address, ledgerId = id('synthetic-credit-ledger')
const owner = Wallet.createRandom().address, operator = Wallet.createRandom().address
const failArtifacts = () => { throw new Error('This local note test must not request proving artifacts.') }
const failSync = () => { throw new Error('This local note test must not synchronize with a network.') }
let directory: string, engine: RailgunEngine, db: Database, tree: Tree, payer: RailgunWallet, feeWallet: RailgunWallet, feeView: AbstractWallet

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ophis-credit-note-'))
  engine = await RailgunEngine.initForWallet('ophiscredittest', new LevelDOWN(join(directory, 'synthetic-wallet-db')),
    { assertArtifactExists: failArtifacts, getArtifacts: failArtifacts, getArtifactsPOI: failArtifacts },
    failSync, failSync, failSync, failSync, undefined)
  db = engine.db
  const prover = engine.prover
  payer = await RailgunWallet.fromMnemonic(db, '11'.repeat(32), Wallet.createRandom().mnemonic!.phrase, 0, undefined, prover)
  feeWallet = await RailgunWallet.fromMnemonic(db, '22'.repeat(32), Wallet.createRandom().mnemonic!.phrase, 0, undefined, prover)
  feeView = await ViewOnlyWallet.fromShareableViewingKey(db, '33'.repeat(32), feeWallet.generateShareableViewingKey(), undefined, prover)
  expect(feeView).toBeInstanceOf(ViewOnlyWallet)
  expect(feeView.getAddress()).toBe(feeWallet.getAddress())
  // These are synthetic local leaves, not a claim of on-chain root/proof validity.
  tree = await UTXOMerkletree.create(db, NETWORK.chain, VERSION, async () => true)
  await feeView.loadUTXOMerkletree(VERSION, tree)
})

afterEach(async () => {
  try { if (engine) await engine.unload() }
  finally { if (directory) rmSync(directory, { recursive: true, force: true }) }
})

function scope() {
  return { chainId: CHAIN_ID, operator, recipient: feeView.getAddress(), token }
}

async function encryptedTransfer(sender: RailgunWallet, recipient: string, memo: string | undefined, label: string, position = 0, tokenAddress = token) {
  const note = TransactNote.createTransfer(getRailgunWalletAddressData(recipient), sender.addressKeys, 123_456n,
    { tokenType: TokenType.ERC20, tokenAddress, tokenSubID: '0' }, false, OutputType.Transfer, memo)
  const keys = getNoteBlindingKeys(sender.viewingPublicKey, note.receiverAddressData.viewingPublicKey, note.random, note.senderRandom!)
  const shared = await getSharedSymmetricKey(sender.viewingKeyPair.privateKey, keys.blindedReceiverViewingKey)
  if (!shared) throw new Error('Synthetic note encryption did not derive a shared key.')
  const encrypted = note.encryptV2(VERSION, shared, sender.masterPublicKey, note.senderRandom, sender.viewingKeyPair.privateKey)
  const commitment: TransactCommitmentV2 = {
    commitmentType: CommitmentType.TransactCommitmentV2,
    hash: ByteUtils.nToHex(note.hash, ByteLength.UINT_256, true), txid: id(label), blockNumber: 100,
    timestamp: 1_800_000_000, utxoTree: 0, utxoIndex: position, railgunTxid: undefined,
    ciphertext: {
      ciphertext: encrypted.noteCiphertext,
      blindedSenderViewingKey: ByteUtils.hexlify(keys.blindedSenderViewingKey),
      blindedReceiverViewingKey: ByteUtils.hexlify(keys.blindedReceiverViewingKey),
      annotationData: `0x${encrypted.annotationData}`, memo: `0x${encrypted.noteMemo}`,
    },
  }
  return { commitment, receipt: receiptFor(commitment), expected: { token: tokenAddress, recipient, memo } }
}

function receiptFor(commitment: TransactCommitmentV2): TransactionReceipt {
  const cipher = commitment.ciphertext, hex = (value: string) => ByteUtils.formatToByteLength(value, ByteLength.UINT_256, true)
  const event = PROXY.encodeEventLog(PROXY.getEvent('Transact')!, [commitment.utxoTree, commitment.utxoIndex, [commitment.hash], [{
    ciphertext: [`0x${cipher.ciphertext.iv}${cipher.ciphertext.tag}`, ...cipher.ciphertext.data.map(hex)],
    blindedSenderViewingKey: hex(cipher.blindedSenderViewingKey), blindedReceiverViewingKey: hex(cipher.blindedReceiverViewingKey),
    annotationData: cipher.annotationData, memo: cipher.memo,
  }]])
  const blockHash = id('synthetic-finalized-block')
  return { hash: commitment.txid, status: 1, blockNumber: commitment.blockNumber, blockHash,
    gasUsed: 100_000n, gasPrice: 1n,
    logs: [{ ...event, address: NETWORK.proxyContract, removed: false, transactionHash: commitment.txid,
      blockNumber: commitment.blockNumber, blockHash }],
  } as unknown as TransactionReceipt
}

async function scan(commitment: TransactCommitmentV2) {
  await tree.queueLeaves(0, commitment.utxoIndex, [commitment])
  await tree.updateTreesFromWriteQueue()
  await feeView.scanLeaves(VERSION, [await tree.getCommitment(0, commitment.utxoIndex)], 0, NETWORK.chain, commitment.utxoIndex, undefined)
}

const corruptMemo = (commitment: TransactCommitmentV2): TransactCommitmentV2 => {
  const memo = commitment.ciphertext.memo
  return { ...commitment, ciphertext: { ...commitment.ciphertext,
    memo: `0x${memo.slice(2, 4) === '00' ? '01' : '00'}${memo.slice(4)}` } }
}

describe('real encrypted prepaid notes', () => {
  it('accepts an explicitly assigned memo-less owner payout only after exact private verification and skips wrong candidates', async () => {
    const wrong = await encryptedTransfer(feeWallet, feeView.getAddress(), undefined, 'wrong-payout')
    const right = await encryptedTransfer(feeWallet, payer.getAddress(), undefined, 'right-payout', 1)
    const later = await encryptedTransfer(feeWallet, payer.getAddress(), undefined, 'later-payout', 2)
    await scan(wrong.commitment); await scan(right.commitment); await scan(later.commitment)
    const sdk = new RailgunSDK(config, {} as Secrets, {} as Store)
    sdk.address = feeView.getAddress(); sdk.ready = () => true
    const receipts = [wrong.receipt, right.receipt, later.receipt]
    const provider = { getNetwork: async () => ({ chainId: BigInt(CHAIN_ID) }),
      getTransactionReceipt: async (hash: string) => receipts.find((receipt) => receipt.hash === hash) ?? null,
      getBlock: async () => ({ number: 100, hash: right.receipt.blockHash, timestamp: 1_800_000_000 }),
    } as unknown as JsonRpcProvider
    const key = id('owner-associated-refund')
    await expect(sdk.confirmedRefund(provider, scope(), ledgerId, key, payer.getAddress(), 123_456n)).rejects.toThrow('must associate')
    const payouts = receipts.map((r) => ({ transaction_hash: r.hash, block_number: r.blockNumber, block_hash: r.blockHash }))
    const proof = await sdk.confirmedRefund(provider, scope(), ledgerId, key, payer.getAddress(), 123_456n, payouts)
    expect(proof.receipt.hash).toBe(right.receipt.hash)
    expect(proof.memo).toBeUndefined()
    expect(proof.amount).toBe(123_456n)
    const remaining = await sdk.confirmedRefund(provider, scope(), ledgerId, key, payer.getAddress(), 123_456n, payouts,
      (commitment) => commitment !== proof.commitment)
    expect(remaining.receipt.hash).toBe(later.receipt.hash)
    await expect(sdk.confirmedRefund(provider, scope(), ledgerId, key, payer.getAddress(), 123_457n, payouts)).rejects.toThrow('not been found')
    await expect(sdk.confirmedRefund(provider, scope(), ledgerId, key, payer.getAddress(), 123_456n,
      payouts.map((p) => ({ ...p, block_hash: id('different-canonical-block') })))).rejects.toThrow('not been found')
  })
  it('does not assign another refund’s memo-tagged output from an owner-authorized batch', async () => {
    const key = id('no-memo-refund'), otherKey = id('memo-refund')
    const tagged = await encryptedTransfer(feeWallet, payer.getAddress(), creditRefundMemo(scope(), ledgerId, otherKey), 'owner-batch')
    const untagged = await encryptedTransfer(feeWallet, payer.getAddress(), undefined, 'owner-batch', 1)
    await scan(tagged.commitment); await scan(untagged.commitment)
    const receipt = { ...tagged.receipt, logs: [...tagged.receipt.logs, ...untagged.receipt.logs] } as unknown as TransactionReceipt
    const provider = { getNetwork: async () => ({ chainId: BigInt(CHAIN_ID) }), getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ number: 100, hash: receipt.blockHash, timestamp: 1_800_000_000 }),
    } as unknown as JsonRpcProvider
    const sdk = new RailgunSDK(config, {} as Secrets, {} as Store)
    sdk.address = feeView.getAddress(); sdk.ready = () => true
    const payouts = [{ transaction_hash: receipt.hash, block_number: receipt.blockNumber, block_hash: receipt.blockHash }]
    const first = await sdk.confirmedRefund(provider, scope(), ledgerId, key, payer.getAddress(), 123_456n, payouts)
    expect(first.commitment).toBe(untagged.commitment.hash)
    await expect(sdk.confirmedRefund(provider, scope(), ledgerId, otherKey, payer.getAddress(), 123_456n)).rejects.toThrow('must associate')
    const second = await sdk.confirmedRefund(provider, scope(), ledgerId, otherKey, payer.getAddress(), 123_456n, payouts,
      (commitment) => commitment !== first.commitment)
    expect(second.commitment).toBe(tagged.commitment.hash)
  })
  it('credits a verified fee-token output even when its same-memo sibling uses the wrong token', async () => {
    const memo = creditMemo(scope(), ledgerId, owner)
    const wrong = await encryptedTransfer(payer, feeView.getAddress(), memo, 'multi-token-topup', 0, TOKENS[1].address)
    const right = await encryptedTransfer(payer, feeView.getAddress(), memo, 'multi-token-topup', 1)
    await scan(wrong.commitment); await scan(right.commitment)
    const receipt = { ...wrong.receipt, logs: [...wrong.receipt.logs, ...right.receipt.logs] } as unknown as TransactionReceipt
    const provider = { getNetwork: async () => ({ chainId: BigInt(CHAIN_ID) }), getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ number: 100, hash: receipt.blockHash, timestamp: 1_800_000_000 }),
    } as unknown as JsonRpcProvider
    const sdk = new RailgunSDK(config, {} as Secrets, {} as Store)
    sdk.address = feeView.getAddress(); sdk.ready = () => true
    const credits = await sdk.confirmedCredits(provider, scope(), ledgerId, owner, receipt.hash)
    expect(credits).toHaveLength(1)
    expect(credits[0]).toMatchObject({ owner, tree: 0, position: 1, amount: 123_456n, commitment: right.commitment.hash })
  })
  it('credits a real view-only scanned transfer only for its exact owner memo and canonical ciphertext', async () => {
    const e = await encryptedTransfer(payer, feeView.getAddress(), creditMemo(scope(), ledgerId, owner), 'credit-top-up')
    await scan(e.commitment)
    const notes = await feeView.TXOs(VERSION, NETWORK.chain)
    expect(notes).toHaveLength(1)
    const txo = notes[0], cached = await tree.getCommitment(txo.tree, txo.position)
    expect(txo.note.memoText).toBe(e.expected.memo)
    expect(txo.note.value).toBe(123_456n)
    expect(verifyReceivedCredit(e.receipt, txo, cached, e.expected)).toBe(123_456n)
    expect(() => verifyReceivedCredit(e.receipt, txo, cached,
      { ...e.expected, memo: creditMemo(scope(), ledgerId, operator) })).toThrow('match')
    expect(() => verifyReceivedCredit(e.receipt, txo, cached, { ...e.expected, recipient: payer.getAddress() })).toThrow('match')
    expect(() => verifyReceivedCredit(receiptFor(corruptMemo(e.commitment)), txo, cached, e.expected)).toThrow('absent')
    expect(() => verifyReceivedCredit(e.receipt, txo, corruptMemo(e.commitment), e.expected)).toThrow('absent')
  })

  it('rejects an encrypted memo changed before view-only scanning', async () => {
    const e = await encryptedTransfer(payer, feeView.getAddress(), creditMemo(scope(), ledgerId, owner), 'tampered-memo')
    await scan(corruptMemo(e.commitment))
    expect(await feeView.TXOs(VERSION, NETWORK.chain)).toEqual([])
  })

  it('rejects a decryptable note when its on-chain commitment hash was substituted', async () => {
    const e = await encryptedTransfer(payer, feeView.getAddress(), creditMemo(scope(), ledgerId, owner), 'tampered-commitment')
    await scan({ ...e.commitment, hash: `0x${'01'.repeat(32)}` })
    expect(await feeView.TXOs(VERSION, NETWORK.chain)).toEqual([])
  })

  it('verifies an outgoing refund using only the sender’s view-only scanned note', async () => {
    const memo = creditRefundMemo(scope(), ledgerId, id('refund-request'))
    const e = await encryptedTransfer(feeWallet, payer.getAddress(), memo, 'owner-refund')
    await scan(e.commitment)
    expect(await feeView.TXOs(VERSION, NETWORK.chain)).toEqual([])
    const { sentCommitments } = await feeView.getSentCommitmentsAndUnshieldEventsNeedPOIs(VERSION, NETWORK.chain)
    expect(sentCommitments).toHaveLength(1)
    const sent = sentCommitments[0]
    expect(sent.isLegacyTransactNote).toBe(false)
    expect(sent.outputType).toBe(OutputType.Transfer)
    expect(sent.note.memoText).toBe(memo)
    const outgoing = { ...sent, blockNumber: sent.note.blockNumber! }
    const cached = await tree.getCommitment(sent.tree, sent.position)
    expect(verifyReceivedCredit(e.receipt, outgoing, cached, e.expected)).toBe(123_456n)
    expect(() => verifyReceivedCredit(e.receipt, outgoing, cached,
      { ...e.expected, memo: creditRefundMemo(scope(), ledgerId, id('different-refund')) })).toThrow('match')
    expect(() => verifyReceivedCredit(e.receipt, outgoing, cached, { ...e.expected, recipient: feeView.getAddress() })).toThrow('match')
    expect(() => verifyReceivedCredit(receiptFor(corruptMemo(e.commitment)), outgoing, cached, e.expected)).toThrow('absent')
  })
})
