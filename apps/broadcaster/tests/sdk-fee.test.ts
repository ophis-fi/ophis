import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import LevelDOWN from 'leveldown'
import { AbiCoder, getAddress, JsonRpcProvider, Wallet } from 'ethers'
import { ByteUtils, ByteLength, CommitmentType, OutputType, POI, type TransactionStructV2, type TXO } from '@railgun-community/engine'
import { ArtifactStore, createRailgunWallet, fullWalletForID, getRailgunWalletAddressData,
  createViewOnlyRailgunWallet, getWalletShareableViewingKey,
  erc20NoteFromERC20AmountRecipient, startRailgunEngine, stopRailgunEngine, setLoggers,
  verifyBroadcasterSignature, toUTF8String, balanceForERC20Token } from '@railgun-community/wallet'
import { Broadcaster } from '../src/broadcaster'
import { RailgunSDK } from '../src/sdk'
import { initializeSecrets, readSecrets, Store } from '../src/storage'
import { NETWORK, NETWORK_NAME, TOKENS, VERSION } from '../src/config'
import { PROXY, parseRequest } from '../src/transaction'
import { config, privateRequest } from './request.fixture'
import { disablePPOI } from '../../railgun/poi-policy'

// Pinned SDK internals only create test ciphertext; production uses public full-wallet APIs.
const require = createRequire(import.meta.url)
const { getNoteBlindingKeys, getSharedSymmetricKey } = require(join(dirname(require.resolve('@railgun-community/engine')), 'utils/keys-utils.js'))
let directory: string, store: Store, sdk: RailgunSDK, senderID: string
const encryption = 'aa'.repeat(32)
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ophis-real-fee-note-'))
  initializeSecrets(join(directory, 'operator.json'), 'fork')
  const secrets = readSecrets(join(directory, 'operator.json'))
  store = new Store(directory)
  setLoggers(() => {}, () => {})
  const artifacts = new ArtifactStore(async () => { throw new Error('No proving artifacts are needed for fee decryption.') }, async () => {}, async () => false)
  disablePPOI(POI, NETWORK)
  await startRailgunEngine('ophistest', new LevelDOWN(join(directory, 'wallet-db')), false, artifacts, false, false)
  const receiving = await createRailgunWallet(encryption, secrets.feeMnemonic!, undefined)
  const sending = await createRailgunWallet(encryption, Wallet.createRandom().mnemonic!.phrase, undefined)
  senderID = sending.id
  const viewingKey = (await getWalletShareableViewingKey(receiving.id))!
  const view = await createViewOnlyRailgunWallet('bb'.repeat(32), viewingKey, undefined)
  expect(view.railgunAddress).toBe(receiving.railgunAddress)
  sdk = new RailgunSDK(config, { gasKey: secrets.gasKey, encryptionKey: 'bb'.repeat(32), feeViewingKey: viewingKey }, store)
  sdk.walletId = view.id; sdk.address = view.railgunAddress
})
afterAll(async () => { await stopRailgunEngine(); store.close(); rmSync(directory, { recursive: true, force: true }) })

async function feeTransaction(address = sdk.address, amount = 123_456n, tokenAddress: string = TOKENS[0].address): Promise<TransactionStructV2> {
  const sender = fullWalletForID(senderID)
  const note = erc20NoteFromERC20AmountRecipient({ recipientAddress: address, tokenAddress, amount },
    sender, OutputType.BroadcasterFee, false, undefined)
  const keys = getNoteBlindingKeys(sender.viewingKeyPair.pubkey, getRailgunWalletAddressData(address).viewingPublicKey,
    note.random, note.senderRandom!)
  const shared = await getSharedSymmetricKey(sender.viewingKeyPair.privateKey, keys.blindedReceiverViewingKey)
  const encrypted = note.encryptV2(VERSION, shared!, sender.masterPublicKey, note.senderRandom, sender.viewingKeyPair.privateKey)
  const ciphertext = { ciphertext: [
    `0x${encrypted.noteCiphertext.iv}${encrypted.noteCiphertext.tag}`,
    ...encrypted.noteCiphertext.data.map((value) => `0x${value}`),
  ], blindedSenderViewingKey: ByteUtils.hexlify(keys.blindedSenderViewingKey, true),
  blindedReceiverViewingKey: ByteUtils.hexlify(keys.blindedReceiverViewingKey, true),
  memo: `0x${encrypted.noteMemo}`, annotationData: `0x${encrypted.annotationData}` }
  const type = PROXY.getFunction('transact')!.inputs[0].arrayChildren!
  const value = Array.from(AbiCoder.defaultAbiCoder().getDefaultValue([type])[0])
  const index = (name: string) => type.components!.findIndex((c) => c.name === name)
  const bound = type.components![index('boundParams')]
  const params = Array.from(value[index('boundParams')] as unknown[])
  params[bound.components!.findIndex((c) => c.name === 'commitmentCiphertext')] = [ciphertext]
  value[index('boundParams')] = params
  value[index('nullifiers')] = [`0x${'12'.repeat(32)}`]
  value[index('commitments')] = [ByteUtils.nToHex(note.hash, ByteLength.UINT_256, true)]
  return value as unknown as TransactionStructV2
}

it('decrypts and authenticates a real SDK fee note without a provider or public wallet', async () => {
  const tx = await feeTransaction()
  const original = parseRequest(await privateRequest('a'.repeat(64), 'b'.repeat(64)), Wallet.createRandom().address, config)
  original.transactions = [tx]
  expect(await sdk.fee(original)).toEqual({ [getAddress(TOKENS[0].address)]: 123_456n })
  const otherAddress = fullWalletForID(senderID).getAddress()
  original.transactions = [await feeTransaction(otherAddress)]
  expect(await sdk.fee(original)).toEqual({})
})

it('authenticates a real private USDC fee commitment in a common withdrawal without PPOI', async () => {
  const tx = await feeTransaction(sdk.address, 1_200_000n, TOKENS[1].address)
  const request = parseRequest(await privateRequest('a'.repeat(64), 'b'.repeat(64)), Wallet.createRandom().address, config)
  request.type4 = false
  const data = PROXY.encodeFunctionData('transact', [[tx]])
  request.transactions = Array.from(PROXY.decodeFunctionData('transact', data)._transactions)
  request.transaction = { to: NETWORK.proxyContract, data }
  expect(await sdk.fee(request)).toEqual({ [getAddress(TOKENS[1].address)]: 1_200_000n })
  expect((await sdk.validate(request)).commitment).toBe(request.transactions[0].commitments[0])
})

it('does not count a later fee note or a ciphertext whose commitment was replaced', async () => {
  const original = parseRequest(await privateRequest('a'.repeat(64), 'b'.repeat(64)), Wallet.createRandom().address, config)
  original.transactions = [await feeTransaction(sdk.address, 7n), await feeTransaction(sdk.address, 999_999n)]
  expect(await sdk.fee(original)).toEqual({ [getAddress(TOKENS[0].address)]: 7n })
  const tampered = Array.from(original.transactions[0] as unknown as unknown[])
  const type = PROXY.getFunction('transact')!.inputs[0].arrayChildren!
  tampered[type.components!.findIndex((c) => c.name === 'commitments')] = [`0x${'99'.repeat(32)}`]
  original.transactions = [tampered as unknown as TransactionStructV2]
  expect(await sdk.fee(original)).toEqual({})
})

it('produces an SDK-verifiable signed fee advertisement without making an unarmed wallet available', async () => {
    const service = new Broadcaster({ ...config, enabled: false }, store, sdk, {} as JsonRpcProvider,
      new Wallet(Wallet.createRandom().privateKey), { broadcastTransaction: async () => { throw new Error('Unarmed.') } },
      { rates: async () => ({ [TOKENS[0].address]: 10n ** 18n }) })
    const signed = JSON.parse(Buffer.from(await service.feeAdvertisement()).toString())
    expect(await verifyBroadcasterSignature(signed.signature, signed.data,
      getRailgunWalletAddressData(sdk.address).viewingPublicKey)).toBe(true)
    const value = JSON.parse(toUTF8String(signed.data))
    expect(value.availableWallets).toBe(0)
    expect(value.railgunAddress).toBe(sdk.address)
    expect(value.feeExpiration).toBeGreaterThan(Date.now() + 60_000)
    expect(value.feesID).toMatch(/^[0-9a-f]{64}$/)
    expect(value.requiredPOIListKeys).toEqual([])
})

it('authenticates the first fee commitment without requesting a PPOI proof', async () => {
  const data = PROXY.encodeFunctionData('transact', [[await feeTransaction()]])
  const original = parseRequest(await privateRequest('a'.repeat(64), 'b'.repeat(64)), Wallet.createRandom().address, config)
  original.type4 = false
  original.transactions = Array.from(PROXY.decodeFunctionData('transact', data)._transactions)
  original.transaction = { to: NETWORK.proxyContract, data }
  original.pois = {}
  expect((await sdk.validate(original)).commitment).toBe(original.transactions[0].commitments[0])
})

it('makes fresh confirmed notes available without PPOI and never counts spent notes', async () => {
  const wallet = fullWalletForID(senderID)
  const note = erc20NoteFromERC20AmountRecipient({ recipientAddress: wallet.getAddress(), tokenAddress: TOKENS[0].address, amount: 700n },
    wallet, OutputType.Transfer, false, undefined)
  const fresh: TXO = { tree: 0, position: 0, txid: `0x${'11'.repeat(32)}`, timestamp: Math.floor(Date.now() / 1000),
    blockNumber: 100, spendtxid: false, nullifier: '12'.repeat(32), note, poisPerList: undefined,
    blindedCommitment: undefined, commitmentType: CommitmentType.ShieldCommitment, transactCreationRailgunTxid: undefined }
  const read = vi.spyOn(wallet, 'TXOs').mockResolvedValue([fresh, { ...fresh, position: 1, spendtxid: `0x${'99'.repeat(32)}` }])
  try {
    expect(await balanceForERC20Token(VERSION, wallet, NETWORK_NAME, TOKENS[0].address, true)).toBe(700n)
  } finally { read.mockRestore() }
})
