import { beforeEach, expect, it, vi } from 'vitest'
import { id, Interface, Transaction, Wallet, ZeroAddress, type JsonRpcSigner } from 'ethers'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ saved: undefined as unknown, index: 0, other: new Map<string, unknown>() }))
vi.mock('./config', () => ({ CHAIN: 8453n, CHAIN_ID: 8453, CONFIG: {
  relayAdapt7702Contract: '0x0000000000000000000000000000000000001234', railgunRegistryContract: '0x0000000000000000000000000000000000005678',
} }))
vi.mock('./storage', () => ({ readPrivateState: async (_s: unknown, k: string) => structuredClone(k === 'baseExecutionSetup' ? state.saved : state.other.get(k)),
  writePrivateState: async (_s: unknown, k: string, v: unknown) => { if (k === 'baseExecutionSetup') state.saved = structuredClone(v); else state.other.set(k, structuredClone(v)) },
  deletePrivateState: async (_s: unknown, k: string) => { if (k === 'baseExecutionSetup') state.saved = undefined; else state.other.delete(k) } }))
vi.mock('./shield', () => ({ assertPublicNetwork: async (_s: unknown, _w: unknown, before?: () => void) => before?.() }))
vi.mock('@railgun-community/wallet', () => ({ fullWalletForID: () => ({ getEphemeralKeyIndex: async () => state.index }) }))

import { baseAccountPrepared, checkBaseExecutionSetup, prepareBaseExecutionSetup, requireBaseExecutionSetup,
  markBaseExecutionSetupUsed, savedBaseExecutionSetup, submitBaseExecutionSetup } from './base-setup'
import { CONFIG } from './config'

beforeEach(() => { state.saved = undefined; state.index = 0; state.other.clear() })
async function fixture() {
  const account = Wallet.createRandom(), payer = Wallet.createRandom(), next = Wallet.createRandom()
  const abi = new Interface(['function nonce() view returns (uint256)', 'function getContractAddress(string) view returns (address)'])
  const chain = { code: '0x', nonce: 0, executeNonce: 0n, current: account.address, canonical: id('block'), network: 8453n,
    tx: undefined as any, receipt: undefined as any, payerNonce: 5, finalized: 101 }
  const provider = {
    getNetwork: async () => ({ chainId: chain.network }),
    getBlock: async (tag: string | number) => ({ number: typeof tag === 'number' ? tag : tag === 'finalized' ? chain.finalized : 101, hash: chain.canonical }),
    getCode: async () => chain.code,
    getTransactionCount: async (address: string) => address === account.address ? chain.nonce : chain.payerNonce,
    call: async (tx: { to: string }) => tx.to === CONFIG.railgunRegistryContract
      ? abi.encodeFunctionResult('getContractAddress', [CONFIG.relayAdapt7702Contract]) : abi.encodeFunctionResult('nonce', [chain.executeNonce]),
    getFeeData: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }),
    estimateGas: vi.fn(async () => 50_000n),
    getTransaction: async () => chain.tx, getTransactionReceipt: async () => chain.receipt,
  }
  const signer = { provider, getAddress: async () => payer.address, sendTransaction: vi.fn(async (tx: any) => {
    chain.tx = { ...tx, from: payer.address, hash: id('setup'), blockHash: id('block'), blockNumber: 100 }
    chain.receipt = { hash: id('setup'), blockHash: id('block'), blockNumber: 100, status: 1 }
    return { hash: id('setup') }
  }) } as unknown as JsonRpcSigner
  const session = { info: { id: 'test' }, provider, accounts: {
    getAccount: async () => ({ address: account.address }), getCurrentAccount: async () => ({ address: chain.current }),
  } } as unknown as WalletSession
  const ready = () => { chain.code = `0xef0100${CONFIG.relayAdapt7702Contract.slice(2)}`; chain.nonce = 1 }
  const prepare = async () => {
    const authorization = await account.authorize({ chainId: 8453n, nonce: 0, address: CONFIG.relayAdapt7702Contract })
    return { version: 1 as const, account: account.address, index: 0, payer: payer.address, payerNonce: 5, createdAt: Date.now(),
      authorization: { address: authorization.address, chainId: '8453', nonce: '0', signature: authorization.signature.serialized },
      gasLimit: '60000', maxFeePerGas: '100', maxPriorityFeePerGas: '1' }
  }
  return { chain, provider, signer, session, account, payer, next, ready, prepare }
}

it('prepares and verifies only a zero-value delegation setup paid by the separate public wallet', async () => {
  const f = await fixture(), setup = await f.prepare()
  expect(setup.account).toBe(f.account.address); expect(setup.payer).toBe(f.payer.address)
  expect(setup.gasLimit).toBe('60000')
  expect(state.saved).toBeUndefined()
  await submitBaseExecutionSetup(f.session, f.signer, setup)
  expect(f.signer.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: ZeroAddress, data: '0x', value: 0n, type: 4, chainId: 8453n }))
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ hash: id('setup') })
  f.ready(); await expect(checkBaseExecutionSetup(f.session)).resolves.toMatchObject({ hash: id('setup'), ready: true })
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ confirmed: true })
  await expect(requireBaseExecutionSetup(f.session, f.account.address)).resolves.toBeUndefined()
  expect(await baseAccountPrepared(f.session, f.account.address)).toBe(true)
  await markBaseExecutionSetupUsed(f.session, f.account.address)
  expect(await baseAccountPrepared(f.session, f.account.address)).toBe(false)
  await expect(requireBaseExecutionSetup(f.session, f.account.address)).resolves.toBeUndefined()
  f.chain.executeNonce = 1n
  expect(await baseAccountPrepared(f.session, f.account.address)).toBe(false)
})

it('never reuses a delegated account after a restore without its local setup journal', async () => {
  const f = await fixture(); f.ready()
  expect(await baseAccountPrepared(f.session, f.account.address)).toBe(false)
  await expect(requireBaseExecutionSetup(f.session, f.account.address)).rejects.toThrow('Prepare this Base execution account')
})

it('journals before disclosure and does not repeat an unknown wallet submission', async () => {
  const f = await fixture(), setup = await f.prepare()
  vi.mocked(f.signer.sendTransaction).mockImplementation(async () => {
    expect(state.saved).toMatchObject({ payerNonce: 5, account: f.account.address })
    throw new Error('response lost')
  })
  await expect(submitBaseExecutionSetup(f.session, f.signer, setup)).rejects.toThrow('response lost')
  await expect(submitBaseExecutionSetup(f.session, f.signer, setup)).rejects.toThrow('saved Base setup')
  expect(f.signer.sendTransaction).toHaveBeenCalledTimes(1)
})

it.each(['payer', 'account', 'nonce', 'chain', 'delegate'])('rejects changed %s before public wallet submission', async (field) => {
  const f = await fixture(), setup = await f.prepare()
  if (field === 'payer') setup.payer = f.next.address
  if (field === 'account') f.chain.current = f.next.address
  if (field === 'nonce') f.chain.payerNonce++
  if (field === 'chain') setup.authorization.chainId = '1'
  if (field === 'delegate') setup.authorization.address = f.next.address
  await expect(submitBaseExecutionSetup(f.session, f.signer, setup)).rejects.toThrow()
  expect(f.signer.sendTransaction).not.toHaveBeenCalled()
})

it.each(['value', 'to', 'payer', 'chain', 'authorization', 'block'])('rejects substituted setup receipt %s', async field => {
  const f = await fixture(), setup = await f.prepare()
  await submitBaseExecutionSetup(f.session, f.signer, setup); f.ready()
  if (field === 'value') f.chain.tx.value = 1n
  if (field === 'to') f.chain.tx.to = f.next.address
  if (field === 'payer') f.chain.tx.from = f.next.address
  if (field === 'chain') f.chain.tx.chainId = 1n
  if (field === 'authorization') f.chain.tx.authorizationList = [await f.next.authorize({ chainId: 8453n, nonce: 0, address: CONFIG.relayAdapt7702Contract })]
  if (field === 'block') f.chain.canonical = id('reorg')
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow()
  expect(await savedBaseExecutionSetup(f.session)).not.toHaveProperty('confirmed')
})

it('permits a fresh review after explicit wallet rejection, but preserves ambiguous errors', async () => {
  const f = await fixture(), setup = await f.prepare()
  vi.mocked(f.signer.sendTransaction).mockRejectedValue({ code: 'ACTION_REJECTED' })
  await expect(submitBaseExecutionSetup(f.session, f.signer, setup)).rejects.toMatchObject({ code: 'ACTION_REJECTED' })
  expect(state.saved).toBeUndefined()
  expect((await f.prepare()).account).toBe(f.account.address)
})

it('recovers a missing response using only the exact saved transaction hash and authorization', async () => {
  const f = await fixture(), setup = await f.prepare()
  await submitBaseExecutionSetup(f.session, f.signer, setup); f.ready()
  delete (state.saved as { hash?: string }).hash
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow('transaction hash')
  await expect(checkBaseExecutionSetup(f.session, id('setup'))).resolves.toMatchObject({ hash: id('setup'), ready: true })
  expect(f.signer.sendTransaction).toHaveBeenCalledTimes(1)
})

it('accepts an authenticated speed-up while retaining the original setup hash', async () => {
  const f = await fixture(), setup = await f.prepare()
  await submitBaseExecutionSetup(f.session, f.signer, setup); f.ready()
  f.chain.tx.hash = id('replacement'); f.chain.receipt.hash = id('replacement')
  await expect(checkBaseExecutionSetup(f.session, id('replacement'))).resolves.toMatchObject({ hash: id('replacement'), ready: true })
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ hash: id('setup'), confirmedHash: id('replacement') })
  expect(f.signer.sendTransaction).toHaveBeenCalledTimes(1)
})

it('permits another setup only after the public-wallet cancellation is finalized and the execution account remains unused', async () => {
  const f = await fixture(), setup = await f.prepare()
  await submitBaseExecutionSetup(f.session, f.signer, setup)
  Object.assign(f.chain.tx, { hash: id('cancel'), to: f.payer.address, type: 2, authorizationList: undefined })
  f.chain.receipt.hash = id('cancel'); f.chain.finalized = 99
  await expect(checkBaseExecutionSetup(f.session, id('cancel'))).rejects.toThrow('finalize')
  f.chain.finalized = 101
  await expect(checkBaseExecutionSetup(f.session, id('cancel'))).resolves.toMatchObject({ hash: id('cancel'), ready: false })
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ hash: id('setup'), cancelled: true })
  expect((await f.prepare()).account).toBe(f.account.address)
})

import { checkBaseSetupRefund, isBaseSetupAccountReserved, listBaseSetupRecoveryIndices, prepareBaseSetupRefund,
  retryBaseSetupRefund, retrySignedBaseExecutionSetup, submitBaseSetupRefund, submitFundedBaseExecutionSetup } from './base-setup'

async function fundedFixture() {
  const account = Wallet.createRandom(), next = Wallet.createRandom(), payer = Wallet.createRandom()
  const abi = new Interface(['function nonce() view returns (uint256)', 'function getContractAddress(string) view returns (address)'])
  const chain = { nonce: 0, pendingNonce: undefined as number | undefined, finalizedNonce: undefined as number | undefined,
    code: '0x', payerCode: '0x', executeNonce: 0n, finalizedExecuteNonce: undefined as bigint | undefined, balance: 0n, finalized: 200, latest: 99, baseFee: 1n,
    reorg: false, dropAck: false, payerNonce: 5, broadcasts: [] as string[], txs: new Map<string, any>(), receipts: new Map<string, any>() }
  const block = (number: number) => ({ number, hash: id(`block${number}${chain.reorg && number === 100 ? '-reorg' : ''}`), timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: chain.baseFee })
  const provider = {
    getNetwork: async () => ({ chainId: 8453n }),
    getBlock: async (tag: string | number) => block(typeof tag === 'number' ? tag : tag === 'finalized' ? chain.finalized : chain.latest),
    getCode: async (address: string) => address === account.address ? chain.code : address === payer.address ? chain.payerCode : '0x',
    getBalance: async (address: string) => address === account.address ? chain.balance : 0n,
    getTransactionCount: async (address: string, tag?: string | number) => address === payer.address ? chain.payerNonce : address !== account.address ? 0
      : tag === 'pending' ? chain.pendingNonce ?? chain.nonce : typeof tag === 'number' && tag <= chain.finalized ? chain.finalizedNonce ?? chain.nonce : chain.nonce,
    call: async (request: any) => request.to === CONFIG.railgunRegistryContract
      ? abi.encodeFunctionResult('getContractAddress', [CONFIG.relayAdapt7702Contract])
      : abi.encodeFunctionResult('nonce', [typeof request.blockTag === 'number' && request.blockTag <= chain.finalized ? chain.finalizedExecuteNonce ?? chain.executeNonce : chain.executeNonce]),
    getFeeData: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
    estimateGas: vi.fn(async () => 21_000n),
    send: vi.fn(async (method: string) => method === 'eth_estimateGas' ? '0x5208' : `0x${100n.toString(16).padStart(64, '0')}`),
    getTransaction: async (hash: string) => chain.txs.get(hash) ?? null,
    getTransactionReceipt: async (hash: string) => chain.receipts.get(hash) ?? null,
    broadcastTransaction: vi.fn(async (raw: string) => {
      chain.broadcasts.push(raw)
      if (chain.dropAck) throw new Error('ack lost')
      return { hash: Transaction.from(raw).hash }
    }),
  }
  const accountSigner = vi.spyOn(account, 'signTransaction')
  const signer = { provider, getAddress: async () => payer.address, sendTransaction: vi.fn(async (tx: any) => {
    const hash = id('funding'), blockNumber = Math.max(100, chain.latest + 1), blockHash = id(`block${blockNumber}`)
    chain.txs.set(hash, { ...tx, from: payer.address, hash, blockNumber, blockHash })
    chain.receipts.set(hash, { hash, blockNumber, blockHash, status: 1 })
    chain.latest = blockNumber + 200
    chain.balance = tx.value
    return { hash, nonce: tx.nonce }
  }) } as unknown as JsonRpcSigner
  const session = { info: { id: 'test' }, provider, accounts: {
    getAccount: async (_chain: bigint, index: number) => ({ address: index === 0 ? account.address : next.address, signer: index === 0 ? account : next }),
    getCurrentAccount: async () => ({ address: state.index === 0 ? account.address : next.address }),
  } } as unknown as WalletSession
  const prepare = () => prepareBaseExecutionSetup(session, signer, { address: account.address, signer: account })
  const fund = async () => { const setup = await prepare(); await submitBaseExecutionSetup(session, signer, setup); await checkBaseExecutionSetup(session); return setup }
  const mine = (raw: string, status = 1) => {
    const tx = Transaction.from(raw), hash = tx.hash!
    chain.txs.set(hash, { hash, chainId: tx.chainId, nonce: tx.nonce, type: tx.type, from: tx.from, to: tx.to,
      value: tx.value, data: tx.data, blockNumber: 110, blockHash: id('block110') })
    chain.receipts.set(hash, { hash, blockNumber: 110, blockHash: id('block110'), status })
    if (tx.type === 4) { chain.nonce = 2; chain.code = `0xef0100${CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}` }
    else { chain.nonce = tx.nonce + 1; if (status === 1) chain.balance -= tx.value }
    chain.pendingNonce = undefined
    return hash
  }
  const prepared = async () => { await fund(); await submitFundedBaseExecutionSetup(session); mine(chain.broadcasts.at(-1)!); await checkBaseExecutionSetup(session) }
  return { session, signer, provider, account, accountSigner, payer, next, chain, prepare, fund, mine, prepared }
}

it('funds the existing account with type2 then explicitly signs outer0/auth1 setup locally and requires EOA2', async () => {
  const f = await fundedFixture(), review = await f.prepare()
  expect(review.version).toBe(2); expect(review.authorization.nonce).toBe('1')
  expect(f.accountSigner).not.toHaveBeenCalled()
  await submitBaseExecutionSetup(f.session, f.signer, review)
  expect(f.signer.sendTransaction).toHaveBeenCalledWith({ type: 2, chainId: 8453n, nonce: 5, to: f.account.address,
    value: BigInt(review.fundingAmount), data: '0x' })
  expect(await baseAccountPrepared(f.session, f.account.address)).toBe(false)
  expect(await checkBaseExecutionSetup(f.session)).toMatchObject({ ready: false, funded: true, stage: 'funding' })
  await submitFundedBaseExecutionSetup(f.session)
  expect(f.signer.sendTransaction).toHaveBeenCalledOnce()
  const raw = f.chain.broadcasts[0], tx = Transaction.from(raw)
  expect(tx).toMatchObject({ type: 4, from: f.account.address, nonce: 0, to: ZeroAddress, value: 0n, data: '0x', gasLimit: 46_000n })
  expect(tx.authorizationList![0].nonce).toBe(1n)
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ signedTransaction: raw, hash: tx.hash })
  f.mine(raw); f.chain.nonce = 1
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow('unused canonical')
  f.chain.nonce = 2
  await expect(checkBaseExecutionSetup(f.session)).resolves.toMatchObject({ ready: true })
  expect(await baseAccountPrepared(f.session, f.account.address)).toBe(true)
})

it.each(['payer', 'recipient', 'value', 'type', 'data', 'reorg', 'old-block', 'authorization'])('rejects substituted funding %s without local signing', async field => {
  const f = await fundedFixture(), setup = await f.prepare()
  await submitBaseExecutionSetup(f.session, f.signer, setup)
  const tx = f.chain.txs.get(id('funding'))
  if (field === 'payer') tx.from = f.next.address
  if (field === 'recipient') tx.to = f.next.address
  if (field === 'value') tx.value++
  if (field === 'type') tx.type = 4
  if (field === 'data') tx.data = '0x1234'
  if (field === 'reorg') f.chain.reorg = true
  if (field === 'old-block') {
    tx.blockNumber = 98; tx.blockHash = id('block98')
    Object.assign(f.chain.receipts.get(id('funding')), { blockNumber: 98, blockHash: id('block98') })
  }
  if (field === 'authorization') tx.authorizationList = [{}]
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow()
  await expect(submitFundedBaseExecutionSetup(f.session)).rejects.toThrow('Confirm the saved funding')
  expect(f.accountSigner).not.toHaveBeenCalled(); expect(f.chain.broadcasts).toEqual([])
})

it('persists exact signed setup before a lost ack and retries only those bytes after reload', async () => {
  const f = await fundedFixture(); await f.fund(); f.chain.dropAck = true
  await expect(submitFundedBaseExecutionSetup(f.session)).rejects.toThrow('ack lost')
  const saved = await savedBaseExecutionSetup(f.session)
  expect(saved).toHaveProperty('signedTransaction', f.chain.broadcasts[0])
  await expect(submitFundedBaseExecutionSetup(f.session)).rejects.toThrow('existing signed')
  f.chain.dropAck = false
  await retrySignedBaseExecutionSetup({ ...f.session })
  expect(f.chain.broadcasts[1]).toBe(f.chain.broadcasts[0]); expect(f.accountSigner).toHaveBeenCalledOnce()
})

it('does not fund a nonempty execution account or accept a fee envelope substitution', async () => {
  const f = await fundedFixture(); f.chain.balance = 1n
  await expect(f.prepare()).rejects.toThrow('not fresh')
  f.chain.balance = 0n
  const review = await f.prepare(); review.feeQuote.unsignedHash = id('wrong envelope')
  await expect(submitBaseExecutionSetup(f.session, f.signer, review)).rejects.toThrow('fee allocation changed')
  expect(f.signer.sendTransaction).not.toHaveBeenCalled()
})

it('returns a funded but never signed setup only to its saved payer and permanently retires it', async () => {
  const f = await fundedFixture(); await f.fund()
  const review = await prepareBaseSetupRefund(f.session)
  expect(review).toMatchObject({ index: 0, account: f.account.address, payer: f.payer.address, nonce: 0 })
  await expect(submitBaseSetupRefund(f.session, { ...review, payer: f.next.address })).rejects.toThrow('saved execution account')
  const hash = await submitBaseSetupRefund(f.session, review)
  const tx = Transaction.from(f.chain.broadcasts[0])
  expect(tx).toMatchObject({ type: 2, from: f.account.address, to: f.payer.address, nonce: 0, value: BigInt(review.value) })
  expect(tx.authorizationList).toBeNull()
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ retired: true, refund: { hash } })
  await expect(submitFundedBaseExecutionSetup(f.session)).rejects.toThrow()
  f.mine(f.chain.broadcasts[0])
  await expect(checkBaseSetupRefund(f.session)).resolves.toMatchObject({ hash, confirmed: true })
  expect(await isBaseSetupAccountReserved(f.session, f.account.address)).toBe(true)
  expect(await listBaseSetupRecoveryIndices(f.session)).toEqual([0])
})

it.each(['pendingSwap', 'pendingWithdrawal', 'preservedWithdrawal', 'nativePrepaidCredit', 'prepaidCredit'])('blocks recovery while %s remains unresolved', async key => {
  const f = await fundedFixture(); await f.fund()
  state.other.set(key, key.includes('Credit') ? { attempt: {} } : {})
  await expect(prepareBaseSetupRefund(f.session)).rejects.toThrow('Reconcile')
  expect(f.accountSigner).not.toHaveBeenCalled()
})

it('a used execution needs finalized contract nonce advancement, not merely higher EOA nonce', async () => {
  const f = await fundedFixture(); await f.prepared(); await markBaseExecutionSetupUsed(f.session, f.account.address)
  f.chain.nonce = 3
  await expect(prepareBaseSetupRefund(f.session)).rejects.toThrow('finish or be cancelled')
  f.chain.executeNonce = 1n; f.chain.finalizedExecuteNonce = 0n
  await expect(prepareBaseSetupRefund(f.session)).rejects.toThrow('finish or be cancelled')
  f.chain.finalizedExecuteNonce = 1n
  await expect(prepareBaseSetupRefund(f.session)).resolves.toMatchObject({ nonce: 3 })
})

it('preserves unknown remainder returns and replays their exact bytes without signing again', async () => {
  const f = await fundedFixture(); await f.fund()
  const review = await prepareBaseSetupRefund(f.session); f.chain.dropAck = true
  await expect(submitBaseSetupRefund(f.session, review)).rejects.toThrow('ack lost')
  await expect(prepareBaseSetupRefund(f.session)).rejects.toThrow('saved remainder')
  f.chain.dropAck = false
  await retryBaseSetupRefund(f.session)
  expect(f.chain.broadcasts[1]).toBe(f.chain.broadcasts[0]); expect(f.accountSigner).toHaveBeenCalledOnce()
})

it('preserves archived payer/index and blocks disclosure after retirement even when another account becomes active', async () => {
  const f = await fundedFixture(); await f.prepared()
  const review = await prepareBaseSetupRefund(f.session)
  await submitBaseSetupRefund(f.session, review)
  await expect(markBaseExecutionSetupUsed(f.session, f.account.address)).rejects.toThrow('journal changed')
  f.mine(f.chain.broadcasts.at(-1)!); await checkBaseSetupRefund(f.session)
  state.index = 1
  const second = await prepareBaseExecutionSetup(f.session, f.signer, { address: f.next.address, signer: f.next })
  await submitBaseExecutionSetup(f.session, f.signer, second)
  expect(await listBaseSetupRecoveryIndices(f.session)).toEqual([1, 0])
  expect(await savedBaseExecutionSetup(f.session, 0)).toMatchObject({ account: f.account.address, payer: f.payer.address, retired: true })
  await expect(prepareBaseSetupRefund(f.session, 2)).rejects.toThrow('No funded Base')
})

it('retains but retires a definitively declined funding request; ambiguous errors still block another payment', async () => {
  const f = await fundedFixture(), review = await f.prepare()
  vi.mocked(f.signer.sendTransaction).mockRejectedValueOnce({ code: 'ACTION_REJECTED' })
  await expect(submitBaseExecutionSetup(f.session, f.signer, review)).rejects.toMatchObject({ code: 'ACTION_REJECTED' })
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ retired: true, cancelled: true })
  expect(await isBaseSetupAccountReserved(f.session, f.account.address)).toBe(true)
  state.other.clear()
  vi.mocked(f.signer.sendTransaction).mockRejectedValueOnce(new Error('transport lost'))
  await expect(submitBaseExecutionSetup(f.session, f.signer, review)).rejects.toThrow('transport lost')
  expect(await savedBaseExecutionSetup(f.session)).not.toHaveProperty('retired')
  await expect(f.prepare()).rejects.toThrow('already saved')
})

it('retires the saved allocation if the user context changes immediately before funding, without calling their wallet', async () => {
  const f = await fundedFixture(), review = await f.prepare()
  let calls = 0
  await expect(submitBaseExecutionSetup(f.session, f.signer, review, () => { if (++calls === 2) throw new Error('account changed') })).rejects.toThrow('account changed')
  expect(f.signer.sendTransaction).not.toHaveBeenCalled()
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ retired: true })
})

it('refuses an archive index that points at a different valid account record', async () => {
  const f = await fundedFixture(); await f.fund()
  const book = state.other.get('baseExecutionSetupsV2') as any
  book.records['1'] = book.records['0']; book.activeIndex = 1
  await expect(savedBaseExecutionSetup(f.session)).rejects.toThrow('index differs')
  await expect(prepareBaseSetupRefund(f.session, 1)).rejects.toThrow('index differs')
})

it('explicitly cancels a pending signed setup at nonce0, preserving both signed transactions', async () => {
  const f = await fundedFixture(); await f.fund(); await submitFundedBaseExecutionSetup(f.session)
  const original = f.chain.broadcasts[0]
  f.chain.pendingNonce = 1
  const review = await prepareBaseSetupRefund(f.session)
  expect(review).toMatchObject({ nonce: 0, cancelsSetup: true })
  expect(BigInt(review.feeQuote.maxFeePerGas)).toBeGreaterThanOrEqual(113n)
  expect(BigInt(review.feeQuote.maxPriorityFeePerGas)).toBeGreaterThanOrEqual(12n)
  await submitBaseSetupRefund(f.session, review)
  const saved = await savedBaseExecutionSetup(f.session)
  expect(saved).toMatchObject({ retired: true, signedTransaction: original, refund: { cancelsSetup: true } })
  f.mine(f.chain.broadcasts[1])
  await expect(checkBaseSetupRefund(f.session)).resolves.toMatchObject({ confirmed: true })
  await expect(submitFundedBaseExecutionSetup(f.session)).rejects.toThrow()
})

it('only the exact finalized setup can supersede its competing return, after which recovery uses EOA2', async () => {
  const f = await fundedFixture(); await f.fund(); await submitFundedBaseExecutionSetup(f.session)
  const setupRaw = f.chain.broadcasts[0], review = await prepareBaseSetupRefund(f.session)
  await submitBaseSetupRefund(f.session, review)
  f.chain.nonce = 2
  await expect(checkBaseSetupRefund(f.session)).rejects.toThrow('finalize')
  f.mine(setupRaw); f.chain.finalized = 109
  await expect(checkBaseSetupRefund(f.session)).rejects.toThrow('finalize')
  f.chain.finalized = 200
  await expect(checkBaseSetupRefund(f.session)).resolves.toMatchObject({ confirmed: true, failed: true })
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ refund: { superseded: true }, signedTransaction: setupRaw })
  await expect(prepareBaseSetupRefund(f.session)).resolves.toMatchObject({ nonce: 2 })
})

it('a finalized failed return preserves evidence and permits a new explicit review at the consumed nonce plus one', async () => {
  const f = await fundedFixture(); await f.fund()
  const review = await prepareBaseSetupRefund(f.session)
  await submitBaseSetupRefund(f.session, review); f.mine(f.chain.broadcasts[0], 0)
  await expect(checkBaseSetupRefund(f.session)).resolves.toMatchObject({ confirmed: true, failed: true })
  await expect(prepareBaseSetupRefund(f.session)).resolves.toMatchObject({ nonce: 1 })
})

it('retirement and private execution disclosure cannot interleave through the local signer await', async () => {
  const f = await fundedFixture(); await f.prepared()
  const review = await prepareBaseSetupRefund(f.session)
  let release!: () => void, reached!: () => void
  const wait = new Promise<void>(resolve => { release = resolve }), signing = new Promise<void>(resolve => { reached = resolve })
  f.accountSigner.mockImplementationOnce(async tx => { reached(); await wait; return Wallet.prototype.signTransaction.call(f.account, tx) })
  const refund = submitBaseSetupRefund(f.session, review)
  await signing
  await expect(markBaseExecutionSetupUsed(f.session, f.account.address)).rejects.toThrow('already in progress')
  release(); await refund
  await expect(markBaseExecutionSetupUsed(f.session, f.account.address)).rejects.toThrow('journal changed')
  expect(await savedBaseExecutionSetup(f.session)).not.toHaveProperty('used')
})


it('does not sign a setup after its available funding becomes insufficient', async () => {
  const f = await fundedFixture(); await f.fund(); f.chain.balance--
  await expect(submitFundedBaseExecutionSetup(f.session)).rejects.toThrow('allocation or estimated fee changed')
  expect(f.accountSigner).not.toHaveBeenCalled(); expect(f.chain.broadcasts).toEqual([])
})

it.each([0, 2])('recovers an exact direct type%s funding despite the public wallet changing its nonce', async type => {
  const f = await fundedFixture(), review = await f.prepare()
  await submitBaseExecutionSetup(f.session, f.signer, review)
  const tx = f.chain.txs.get(id('funding')); tx.nonce += 3; tx.type = type
  await expect(checkBaseExecutionSetup(f.session)).resolves.toMatchObject({ funded: true })
  await submitFundedBaseExecutionSetup(f.session)
  expect(f.accountSigner).toHaveBeenCalledOnce()
})

it('accepts donated dust without increasing the approved setup allocation or fees', async () => {
  const f = await fundedFixture(), review = await f.fund(); f.chain.balance++
  await submitFundedBaseExecutionSetup(f.session)
  const saved = await savedBaseExecutionSetup(f.session), tx = Transaction.from(f.chain.broadcasts[0])
  expect(saved).toMatchObject({ fundingAmount: review.fundingAmount, feeQuote: review.feeQuote })
  expect(tx.maxFeePerGas).toBe(BigInt(review.maxFeePerGas))
  expect(f.signer.sendTransaction).toHaveBeenCalledOnce()
})

it('refuses unsupported funding payers before review and again before the wallet request', async () => {
  const f = await fundedFixture(); f.chain.payerCode = '0x6000'
  await expect(f.prepare()).rejects.toThrow('cannot send the direct setup payment')
  f.chain.payerCode = `0xef0100${f.next.address.slice(2)}`
  const review = await f.prepare(); f.chain.payerCode = '0x6000'
  await expect(submitBaseExecutionSetup(f.session, f.signer, review)).rejects.toThrow('cannot send the direct setup payment')
  expect(f.signer.sendTransaction).not.toHaveBeenCalled()
})

it('does not sign an impossible retained fee cap and permits a fresh check once base fees fall', async () => {
  const f = await fundedFixture(); await f.fund(); f.chain.baseFee = 91n
  await expect(submitFundedBaseExecutionSetup(f.session)).rejects.toThrow('fees exceed the saved setup limit')
  expect(f.accountSigner).not.toHaveBeenCalled(); expect(f.chain.broadcasts).toEqual([])
  f.chain.baseFee = 90n
  await submitFundedBaseExecutionSetup(f.session)
  expect(f.accountSigner).toHaveBeenCalledOnce()
})

it('verifies late funding for a retired archived index without changing the newer active record', async () => {
  const f = await fundedFixture(), first = await f.prepare()
  vi.mocked(f.signer.sendTransaction).mockRejectedValueOnce({ code: 4001 })
  await expect(submitBaseExecutionSetup(f.session, f.signer, first)).rejects.toMatchObject({ code: 4001 })
  state.index = 1
  const next = await prepareBaseExecutionSetup(f.session, f.signer, { address: f.next.address, signer: f.next })
  await submitBaseExecutionSetup(f.session, f.signer, next)
  const late = id('late funding')
  f.chain.txs.set(late, { hash: late, from: f.payer.address, to: f.account.address, value: BigInt(first.fundingAmount),
    type: 0, nonce: 8, chainId: 8453n, data: '0x', blockNumber: 100, blockHash: id('block100') })
  f.chain.receipts.set(late, { hash: late, blockNumber: 100, blockHash: id('block100'), status: 1 })
  f.chain.balance = BigInt(first.fundingAmount)
  await expect(checkBaseExecutionSetup(f.session, late, 0)).resolves.toMatchObject({ funded: true, stage: 'cancelled' })
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ index: 1 })
  expect(await savedBaseExecutionSetup(f.session, 0)).toMatchObject({ retired: true, fundingConfirmedHash: late })
  await expect(prepareBaseSetupRefund(f.session, 0)).resolves.toMatchObject({ index: 0, payer: first.payer })
  await expect(checkBaseExecutionSetup(f.session, late, 2)).rejects.toThrow('No Base setup')
})

it('retires a missing-hash request only after finalized payer progress and canonical empty account checks', async () => {
  const f = await fundedFixture(), review = await f.prepare()
  vi.mocked(f.signer.sendTransaction).mockRejectedValueOnce(new Error('transport lost'))
  await expect(submitBaseExecutionSetup(f.session, f.signer, review)).rejects.toThrow('transport lost')
  f.chain.latest = 300
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow('transaction hash')
  f.chain.payerNonce++
  const count = f.provider.getTransactionCount
  const countSpy = vi.spyOn(f.provider, 'getTransactionCount').mockImplementation(async (address, tag) =>
    address === f.payer.address && tag === f.chain.finalized ? 5 : count(address, tag))
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow('transaction hash')
  countSpy.mockRestore()
  f.chain.balance = 1n
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow('transaction hash')
  f.chain.balance = 0n; f.chain.pendingNonce = 1
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow('transaction hash')
  f.chain.pendingNonce = 0
  const getBlock = f.provider.getBlock
  const blockSpy = vi.spyOn(f.provider, 'getBlock').mockImplementation(async tag => ({ ...await getBlock(tag),
    ...(tag === f.chain.finalized ? { hash: id('changed finalized anchor') } : {}) }))
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow('transaction hash')
  blockSpy.mockRestore()
  await expect(checkBaseExecutionSetup(f.session)).resolves.toEqual({ ready: false, stage: 'cancelled', lateFundingPossible: true })
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ retired: true, cancelled: true })
  expect(await isBaseSetupAccountReserved(f.session, f.account.address)).toBe(true)
})

it('reserves a cancelled legacy account even without a v2 book', async () => {
  const f = await fixture(), legacy = await f.prepare()
  state.saved = { ...legacy, cancelled: true }
  expect(await isBaseSetupAccountReserved(f.session, f.account.address)).toBe(true)
  expect(await isBaseSetupAccountReserved(f.session, f.next.address)).toBe(false)
})

it('retires a dropped returned funding hash without losing its recovery data or resending', async () => {
  const f = await fundedFixture(), review = await f.prepare()
  await submitBaseExecutionSetup(f.session, f.signer, review)
  f.chain.receipts.delete(id('funding')); f.chain.txs.delete(id('funding')); f.chain.balance = 0n
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow('no confirmed receipt')
  f.chain.payerNonce++
  await expect(checkBaseExecutionSetup(f.session)).resolves.toMatchObject({ hash: id('funding'), stage: 'cancelled', lateFundingPossible: true })
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ fundingHash: id('funding'), fundingNonce: 5, retired: true })
  expect(await isBaseSetupAccountReserved(f.session, f.account.address)).toBe(true)
  expect(f.signer.sendTransaction).toHaveBeenCalledOnce(); expect(f.accountSigner).not.toHaveBeenCalled()
})

it('binds cancellation to the wallet-reported funding nonce rather than the stale review nonce', async () => {
  const f = await fundedFixture(), review = await f.prepare(), send = f.signer.sendTransaction.bind(f.signer)
  vi.mocked(f.signer.sendTransaction).mockImplementationOnce(async tx => {
    const result = await send(tx)
    f.chain.txs.get(id('funding')).nonce = 8
    return { ...result, nonce: 8 } as any
  })
  await submitBaseExecutionSetup(f.session, f.signer, review)
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ payerNonce: 5, fundingNonce: 8 })
  const hash = id('wallet cancellation'), tx = { ...f.chain.txs.get(id('funding')), hash, to: f.payer.address, value: 0n, nonce: 5 }
  f.chain.txs.set(hash, tx); f.chain.receipts.set(hash, { ...f.chain.receipts.get(id('funding')), hash })
  f.chain.balance = 0n
  await expect(checkBaseExecutionSetup(f.session, hash)).rejects.toThrow('does not match')
  tx.nonce = 8
  await expect(checkBaseExecutionSetup(f.session, hash)).resolves.toMatchObject({ hash, stage: 'cancelled' })
  expect(await savedBaseExecutionSetup(f.session)).toMatchObject({ retired: true, fundingNonce: 8 })
})

it('does not retire a dropped hash merely because the stale reviewed nonce advanced', async () => {
  const f = await fundedFixture(), review = await f.prepare()
  await submitBaseExecutionSetup(f.session, f.signer, review)
  const book = state.other.get('baseExecutionSetupsV2') as any; book.records['0'].fundingNonce = 8
  f.chain.receipts.delete(id('funding')); f.chain.balance = 0n; f.chain.payerNonce = 6
  await expect(checkBaseExecutionSetup(f.session)).rejects.toThrow('no confirmed receipt')
  expect(await savedBaseExecutionSetup(f.session)).not.toHaveProperty('retired')
  f.chain.payerNonce = 9
  await expect(checkBaseExecutionSetup(f.session)).resolves.toMatchObject({ stage: 'cancelled', lateFundingPossible: true })
})
