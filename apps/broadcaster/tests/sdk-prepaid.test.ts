import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import LevelDOWN from 'leveldown'
import { id, Wallet, ZeroHash, type Result } from 'ethers'
import { ByteLength, ByteUtils, OutputType, POI, RailgunEngine, RailgunWallet, TransactNote, TokenType,
  ViewOnlyWallet, type AbstractWallet, type TransactionStructV2 } from '@railgun-community/engine'
import { getRailgunWalletAddressData } from '@railgun-community/wallet'
import { disablePPOI } from '../../railgun/poi-policy'
import { NETWORK, TOKENS, VERSION } from '../src/config'
import { RailgunSDK } from '../src/sdk'
import type { Secrets, Store } from '../src/storage'
import { PROXY, parseRequest, type ParsedRequest } from '../src/transaction'
import { config, signedWithdrawalRequest, withdrawalRequest } from './request.fixture'

vi.mock('@railgun-community/wallet', async (original) => ({ ...await original<typeof import('@railgun-community/wallet')>(),
  walletForID: () => viewingWallet }))

// Only synthetic note construction needs these pinned engine helpers. Validation uses the real wallet API.
const require = createRequire(import.meta.url)
const engineRoot = dirname(require.resolve('@railgun-community/engine'))
const { getNoteBlindingKeys, getSharedSymmetricKey } = require(join(engineRoot, 'utils/keys-utils.js'))
const operator = Wallet.createRandom().address, recipient = Wallet.createRandom().address
const feesID = 'a'.repeat(64), publicViewingKey = 'b'.repeat(64)
let directory: string, engine: RailgunEngine, sender: RailgunWallet, viewingWallet: AbstractWallet, sdk: RailgunSDK
const unavailable = () => { throw new Error('Synthetic prepaid decoding must not fetch artifacts or synchronize.') }

// Proof fields are synthetic: these tests verify SDK decoding policy, not spend-proof validity or chain execution.
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ophis-sdk-prepaid-'))
  disablePPOI(POI, NETWORK)
  engine = await RailgunEngine.initForWallet('ophisprepaidtest', new LevelDOWN(join(directory, 'synthetic-wallet-db')),
    { assertArtifactExists: unavailable, getArtifacts: unavailable, getArtifactsPOI: unavailable },
    unavailable, unavailable, unavailable, unavailable, undefined)
  sender = await RailgunWallet.fromMnemonic(engine.db, '11'.repeat(32), Wallet.createRandom().mnemonic!.phrase, 0, undefined, engine.prover)
  const receiver = await RailgunWallet.fromMnemonic(engine.db, '22'.repeat(32), Wallet.createRandom().mnemonic!.phrase, 0, undefined, engine.prover)
  viewingWallet = await ViewOnlyWallet.fromShareableViewingKey(engine.db, '33'.repeat(32), receiver.generateShareableViewingKey(), undefined, engine.prover)
  sdk = new RailgunSDK(config, {} as Secrets, {} as Store)
  sdk.walletId = viewingWallet.id; sdk.address = viewingWallet.getAddress()
})
beforeEach(() => { vi.spyOn(viewingWallet, 'isValidSpendableTransaction') })
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => {
  try { if (engine) await engine.unload() }
  finally { if (directory) rmSync(directory, { recursive: true, force: true }) }
})

async function common(): Promise<ParsedRequest> {
  return parseRequest(await withdrawalRequest(feesID, publicViewingKey, recipient, 1, 1, TOKENS[0].address,
    id('synthetic-full-unshield-nullifier'), true), operator, config, true)
}

// Keep synthetic calldata and its parsed fields consistent even when probing shapes rejected by production parsing.
function replaceTransactions(request: ParsedRequest, transform: (transactions: TransactionStructV2[]) => TransactionStructV2[]): ParsedRequest {
  const transactions = PROXY.decodeFunctionData('transact', PROXY.encodeFunctionData('transact', [request.transactions]))
    ._transactions.map((tx: Result) => ({ ...tx.toObject(), nullifiers: Array.from(tx.nullifiers), commitments: Array.from(tx.commitments),
      boundParams: { ...tx.boundParams.toObject(), commitmentCiphertext: Array.from(tx.boundParams.commitmentCiphertext) },
    })) as TransactionStructV2[]
  const data = PROXY.encodeFunctionData('transact', [transform(transactions)])
  return { ...request, transactions: Array.from(PROXY.decodeFunctionData('transact', data)._transactions) as TransactionStructV2[],
    transaction: { ...request.transaction, data } }
}

it('accepts a parsed full COMMON withdrawal although the installed SDK demands a nonexistent first ciphertext', async () => {
  const request = await common()
  const decoded = await viewingWallet.isValidSpendableTransaction(VERSION, NETWORK.chain,
    String(request.transaction.to), request.transaction, false, {}, false)
  expect(decoded.isValid).toBe(false)
  expect(decoded.error).toContain('No ciphertext found for commitment at index 0')
  vi.mocked(viewingWallet.isValidSpendableTransaction).mockClear()
  await expect(sdk.validatePrepaid(request)).resolves.toBeUndefined()
  expect(viewingWallet.isValidSpendableTransaction).not.toHaveBeenCalled()
})

it('accepts a parsed signed full bound withdrawal without requesting fee-note decoding', async () => {
  const request = parseRequest(await signedWithdrawalRequest(feesID, publicViewingKey, recipient, TOKENS[0].address),
    operator, { ...config, executionGuard: Wallet.createRandom().address }, true)
  expect(request.type4).toBe(true)
  expect(request.withdrawal?.recipient).toBe(recipient)
  await expect(sdk.validatePrepaid(request)).resolves.toBeUndefined()
  expect(viewingWallet.isValidSpendableTransaction).not.toHaveBeenCalled()
})

it('does not apply the full-withdrawal exception to a type-4 swap without a validated withdrawal', async () => {
  const request = parseRequest(await signedWithdrawalRequest(feesID, publicViewingKey, recipient, TOKENS[0].address,
    id('synthetic-swap-nullifier'), (_transactions, action) => { action.requireSuccess = false; action.calls = [] }), operator, config, true)
  expect(request.withdrawal).toBeUndefined()
  expect(BigInt(request.transactions[0].boundParams.unshield)).toBe(1n)
  await expect(sdk.validatePrepaid(request)).rejects.toThrow('could not be decoded')
  expect(viewingWallet.isValidSpendableTransaction).toHaveBeenCalledOnce()
})

it.each(['multiple-proofs', 'extra-commitment', 'no-commitment', 'no-unshield', 'empty-nullifiers', 'zero-nullifier'] as const)(
  'keeps %s on the real SDK rejection path', async (kind) => {
    const request = replaceTransactions(await common(), ([tx]) => {
      if (kind === 'multiple-proofs') return [tx, { ...tx, nullifiers: [id('second-nullifier')] }]
      if (kind === 'extra-commitment') return [{ ...tx, commitments: [...tx.commitments, id('extra-commitment')] }]
      if (kind === 'no-commitment') return [{ ...tx, commitments: [] }]
      if (kind === 'no-unshield') return [{ ...tx, boundParams: { ...tx.boundParams, unshield: 0n } }]
      return [{ ...tx, nullifiers: kind === 'empty-nullifiers' ? [] : [ZeroHash] }]
    })
    await expect(sdk.validatePrepaid(request)).rejects.toThrow('could not be decoded')
    expect(viewingWallet.isValidSpendableTransaction).toHaveBeenCalledOnce()
  })

it.each([false, true])('decodes and rejects a real embedded fee with any ciphertext (retained unshield commitment: %s)', async (retainUnshield) => {
  const note = TransactNote.createTransfer(getRailgunWalletAddressData(sdk.address), sender.addressKeys, 123n,
    { tokenType: TokenType.ERC20, tokenAddress: TOKENS[0].address, tokenSubID: '0' }, false, OutputType.BroadcasterFee, undefined)
  const keys = getNoteBlindingKeys(sender.viewingPublicKey, note.receiverAddressData.viewingPublicKey, note.random, note.senderRandom!)
  const shared = await getSharedSymmetricKey(sender.viewingKeyPair.privateKey, keys.blindedReceiverViewingKey)
  const encrypted = note.encryptV2(VERSION, shared, sender.masterPublicKey, note.senderRandom, sender.viewingKeyPair.privateKey)
  const ciphertext = {
    ciphertext: [`0x${encrypted.noteCiphertext.iv}${encrypted.noteCiphertext.tag}`, ...encrypted.noteCiphertext.data.map((value) => `0x${value}`)] as [string, string, string, string],
    blindedSenderViewingKey: ByteUtils.hexlify(keys.blindedSenderViewingKey, true),
    blindedReceiverViewingKey: ByteUtils.hexlify(keys.blindedReceiverViewingKey, true),
    annotationData: `0x${encrypted.annotationData}`, memo: `0x${encrypted.noteMemo}`,
  }
  const request = replaceTransactions(await common(), ([tx]) => [{ ...tx,
    commitments: [ByteUtils.nToHex(note.hash, ByteLength.UINT_256, true), ...(retainUnshield ? tx.commitments : [])],
    boundParams: { ...tx.boundParams, commitmentCiphertext: [ciphertext] },
  }])
  await expect(sdk.validatePrepaid(request)).rejects.toThrow('embedded broadcaster fee')
  expect(viewingWallet.isValidSpendableTransaction).toHaveBeenCalledOnce()
})

it('rejects active POI lists before the full-unshield exception or SDK decoding', async () => {
  const request = await common()
  vi.spyOn(POI, 'getActiveListKeys').mockReturnValue(['synthetic-active-list'])
  await expect(sdk.validatePrepaid(request)).rejects.toThrow('wallet policy')
  expect(viewingWallet.isValidSpendableTransaction).not.toHaveBeenCalled()
})
