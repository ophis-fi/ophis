import { ByteLength, ByteUtils, CommitmentType, TokenType, type Commitment, type TXO } from '@railgun-community/engine'
import { getRailgunWalletAddressData, parseRailgunTokenAddress } from '@railgun-community/wallet'
import { getAddress, isHexString, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { CHAIN, NETWORK } from './config'
import { PROXY } from './transaction'

type ReceiptProvider = Pick<JsonRpcProvider, 'getNetwork' | 'getBlock' | 'getTransactionReceipt'>
const verifiedReceipts = new WeakMap<TransactionReceipt, Readonly<{ hash: string; blockNumber: number; blockHash: string;
  gasUsed: bigint; gasPrice: bigint; status: number; minedAt: number }>>()

export function finalizedCreditEvidence(receipt: TransactionReceipt) {
  const evidence = verifiedReceipts.get(receipt)
  if (!evidence) throw new Error('A verified finalized receipt is required to settle credit.')
  return evidence
}

/** Only canonical finalized receipts may create or release spendable credit. */
export async function finalizedCreditReceipt(provider: ReceiptProvider, transactionHash: string): Promise<TransactionReceipt> {
  if (!isHexString(transactionHash, 32) || (await provider.getNetwork()).chainId !== CHAIN)
    throw new Error('Invalid credit receipt network or transaction.')
  const [receipt, finalized] = await Promise.all([provider.getTransactionReceipt(transactionHash), provider.getBlock('finalized')])
  if (!receipt || receipt.hash.toLowerCase() !== transactionHash.toLowerCase() ||
    !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 ||
    !finalized || !Number.isSafeInteger(finalized.number) || finalized.number < receipt.blockNumber ||
    !isHexString(finalized.hash, 32) || !isHexString(receipt.blockHash, 32))
    throw new Error('Payment or operation is not finalized yet.')
  const canonical = await provider.getBlock(receipt.blockNumber)
  if (!canonical || canonical.hash !== receipt.blockHash || canonical.number !== receipt.blockNumber ||
    (finalized.number === receipt.blockNumber && finalized.hash !== receipt.blockHash) ||
    !Number.isSafeInteger(canonical.timestamp) || canonical.timestamp <= 0 ||
    (receipt.status !== 0 && receipt.status !== 1) || typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed <= 0n ||
    typeof receipt.gasPrice !== 'bigint' || receipt.gasPrice <= 0n)
    throw new Error('The credit receipt is not on the canonical finalized chain.')
  verifiedReceipts.set(receipt, Object.freeze({ hash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed, gasPrice: receipt.gasPrice, status: receipt.status, minedAt: canonical.timestamp * 1000 }))
  return receipt
}

export function verifyReceivedCredit(receipt: TransactionReceipt, txo: Pick<TXO, 'note' | 'txid' | 'tree' | 'position' | 'blockNumber' | 'commitmentType'>, commitment: Commitment,
  expected: { token: string; recipient: string; memo: string | undefined }): bigint {
  const note = txo.note, recipient = getRailgunWalletAddressData(expected.recipient)
  if (receipt.status !== 1 || txo.commitmentType !== CommitmentType.TransactCommitmentV2 ||
    commitment.commitmentType !== CommitmentType.TransactCommitmentV2 || note.memoText !== expected.memo ||
    note.value <= 0n || note.tokenData.tokenType !== TokenType.ERC20 || BigInt(note.tokenData.tokenSubID) !== 0n ||
    getAddress(parseRailgunTokenAddress(note.tokenData.tokenAddress)) !== getAddress(expected.token) ||
    note.receiverAddressData.masterPublicKey !== recipient.masterPublicKey ||
    !Buffer.from(note.receiverAddressData.viewingPublicKey).equals(Buffer.from(recipient.viewingPublicKey)))
    throw new Error('The private payment does not match its owner, recipient or fee token.')
  const hex32 = (value: string | bigint) => typeof value === 'bigint'
    ? ByteUtils.nToHex(value, ByteLength.UINT_256, true).toLowerCase()
    : ByteUtils.formatToByteLength(value, ByteLength.UINT_256, true).toLowerCase()
  if (hex32(txo.txid) !== receipt.hash.toLowerCase() || hex32(commitment.txid) !== receipt.hash.toLowerCase() ||
    txo.blockNumber !== receipt.blockNumber || commitment.blockNumber !== receipt.blockNumber ||
    txo.tree !== commitment.utxoTree || txo.position !== commitment.utxoIndex ||
    hex32(note.hash) !== hex32(commitment.hash)) throw new Error('The private payment has inconsistent scan evidence.')
  // The note hash does not bind its memo; compare the scanned ciphertext with the canonical event too.
  const cipher = commitment.ciphertext
  const serialized = { ciphertext: [`0x${cipher.ciphertext.iv}${cipher.ciphertext.tag}`, ...cipher.ciphertext.data.map(hex32)],
    blindedSenderViewingKey: hex32(cipher.blindedSenderViewingKey), blindedReceiverViewingKey: hex32(cipher.blindedReceiverViewingKey),
    annotationData: cipher.annotationData, memo: cipher.memo }
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(NETWORK.proxyContract) || log.removed ||
      log.transactionHash !== receipt.hash || log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber) continue
    const event = PROXY.parseLog(log)
    if (event?.name !== 'Transact' || event.args.treeNumber !== BigInt(txo.tree)) continue
    const index = BigInt(txo.position) - event.args.startPosition
    if (index < 0n || index >= BigInt(event.args.hash.length) || event.args.hash[Number(index)].toLowerCase() !== hex32(note.hash)) continue
    const actual = event.args.ciphertext[Number(index)]
    const encode = (ciphertext: unknown) => PROXY.encodeEventLog(PROXY.getEvent('Transact')!, [0, 0, [hex32(note.hash)], [ciphertext]]).data
    if (actual && encode(actual) === encode(serialized)) return note.value
  }
  throw new Error('The private payment commitment or ciphertext is absent from its canonical receipt.')
}
