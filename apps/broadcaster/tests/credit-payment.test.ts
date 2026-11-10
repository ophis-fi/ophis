import { describe, expect, it } from 'vitest'
import { ByteLength, ByteUtils, CommitmentType, OutputType, TokenType, TransactNote, type TXO, type TransactCommitmentV2 } from '@railgun-community/engine'
import { getRailgunWalletAddressData } from '@railgun-community/wallet'
import { id, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { finalizedCreditReceipt, verifyReceivedCredit } from '../src/credit-payment'
import { CHAIN, NETWORK, TOKENS } from '../src/config'
import { PROXY } from '../src/transaction'

const recipient = '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
function evidence() {
  const note = TransactNote.createTransfer(getRailgunWalletAddressData(recipient), undefined, 100n,
    { tokenType: TokenType.ERC20, tokenAddress: TOKENS[0].address, tokenSubID: '0' }, false, OutputType.Transfer, 'owned-credit')
  const hash = ByteUtils.nToHex(note.hash, ByteLength.UINT_256, true), txid = id('top-up'), blockHash = id('block')
  const word = id('ciphertext').slice(2)
  const commitment: TransactCommitmentV2 = { commitmentType: CommitmentType.TransactCommitmentV2,
    hash, txid, blockNumber: 10, timestamp: undefined, utxoTree: 2, utxoIndex: 7, railgunTxid: undefined,
    ciphertext: { ciphertext: { iv: word.slice(0, 32), tag: word.slice(32), data: [word, word, word] },
      blindedSenderViewingKey: word, blindedReceiverViewingKey: word, annotationData: '0x1234', memo: '0x5678' } }
  const encoded = PROXY.encodeEventLog(PROXY.getEvent('Transact')!, [2, 7, [hash], [{
    ciphertext: Array(4).fill(`0x${word}`), blindedSenderViewingKey: `0x${word}`, blindedReceiverViewingKey: `0x${word}`,
    annotationData: '0x1234', memo: '0x5678',
  }]])
  const receipt = { hash: txid, blockHash, blockNumber: 10, status: 1, gasUsed: 100n, gasPrice: 2n,
    logs: [{ ...encoded, address: NETWORK.proxyContract, removed: false, transactionHash: txid, blockHash, blockNumber: 10 }],
  } as unknown as TransactionReceipt
  const txo = { txid, blockNumber: 10, tree: 2, position: 7, note, commitmentType: CommitmentType.TransactCommitmentV2 } as TXO
  return { receipt, txo, commitment, expected: { token: TOKENS[0].address, recipient, memo: 'owned-credit' } }
}

describe('canonical private credit evidence', () => {
  it('matches the exact received amount, owner memo, receipt, commitment position and encrypted payload', () => {
    const e = evidence()
    expect(verifyReceivedCredit(e.receipt, e.txo, e.commitment, e.expected)).toBe(100n)
    expect(() => verifyReceivedCredit(e.receipt, e.txo, e.commitment, { ...e.expected, memo: 'stolen-credit' })).toThrow('match')
    expect(() => verifyReceivedCredit(e.receipt, e.txo, e.commitment, { ...e.expected, token: TOKENS[1].address })).toThrow('match')
    expect(() => verifyReceivedCredit({ ...e.receipt, status: 0 } as TransactionReceipt, e.txo, e.commitment, e.expected)).toThrow('match')
    expect(() => verifyReceivedCredit(e.receipt, { ...e.txo, position: 8 }, e.commitment, e.expected)).toThrow('inconsistent')
    expect(() => verifyReceivedCredit(e.receipt, e.txo, { ...e.commitment, txid: id('copied') }, e.expected)).toThrow('inconsistent')
    expect(() => verifyReceivedCredit(e.receipt, e.txo,
      { ...e.commitment, ciphertext: { ...e.commitment.ciphertext, memo: '0x9999' } }, e.expected)).toThrow('absent')
    const forged = { ...e.receipt, logs: [{ ...e.receipt.logs[0], address: TOKENS[0].address }] } as unknown as TransactionReceipt
    expect(() => verifyReceivedCredit(forged, e.txo, e.commitment, e.expected)).toThrow('absent')
  })
  it('requires finalized canonical inclusion on the configured chain, with no confirmation-count fallback', async () => {
    const { receipt } = evidence()
    let finalized = 10, canonicalHash = receipt.blockHash, chain = CHAIN
    const provider = { getNetwork: async () => ({ chainId: chain }), getTransactionReceipt: async () => receipt,
      getBlock: async (tag: string | number) => ({ number: tag === 'finalized' ? finalized : tag, hash: canonicalHash, timestamp: 1234567890 }),
    } as unknown as JsonRpcProvider
    expect(await finalizedCreditReceipt(provider, receipt.hash)).toBe(receipt)
    finalized = 9
    await expect(finalizedCreditReceipt(provider, receipt.hash)).rejects.toThrow('not finalized')
    finalized = 10; canonicalHash = id('reorg')
    await expect(finalizedCreditReceipt(provider, receipt.hash)).rejects.toThrow('canonical')
    canonicalHash = receipt.blockHash; chain = CHAIN === 1n ? 56n : 1n
    await expect(finalizedCreditReceipt(provider, receipt.hash)).rejects.toThrow('network')
  })
  it.each([0n, -1n, 0, '0', undefined])('validates funding receipt gas price %s independently of the transferred value', async (gasPrice) => {
    const { receipt } = evidence()
    Object.assign(receipt, { gasPrice })
    const provider = { getNetwork: async () => ({ chainId: CHAIN }), getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ number: receipt.blockNumber, hash: receipt.blockHash, timestamp: 1234567890 }),
    } as unknown as JsonRpcProvider
    if (gasPrice === 0n) expect(await finalizedCreditReceipt(provider, receipt.hash)).toBe(receipt)
    else await expect(finalizedCreditReceipt(provider, receipt.hash)).rejects.toThrow('canonical')
  })
})
