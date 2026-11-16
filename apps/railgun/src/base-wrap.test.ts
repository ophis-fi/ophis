import { beforeEach, expect, it, vi } from 'vitest'
import { id, Interface, JsonRpcProvider, ZeroHash, type JsonRpcSigner } from 'ethers'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ saved: undefined as unknown, network: vi.fn(), balance: vi.fn() }))
const payer = '0x0000000000000000000000000000000000000001'
const wrapped = '0x4200000000000000000000000000000000000006'
const other = '0x0000000000000000000000000000000000000002'
vi.mock('./config', () => ({ CHAIN: 8453n, CHAIN_ID: 8453, WRAPPED_SYMBOL: 'WETH', tokenFor: () => ({ address: wrapped }) }))
vi.mock('./storage', () => ({ readPrivateState: async () => structuredClone(state.saved),
  writePrivateState: async (_s: unknown, _k: unknown, v: unknown) => { state.saved = structuredClone(v) },
  deletePrivateState: async () => { state.saved = undefined } }))
vi.mock('./shield', () => ({ requireShieldBalance: state.balance,
  assertPublicNetwork: async (_s: unknown, _w: unknown, before?: () => void) => { await state.network(); before?.() } }))
import { baseWrapRecords, checkBaseWrap, deferBaseWrap, savedBaseWrap, wrapBaseNative } from './base-wrap'

beforeEach(() => { state.saved = undefined; state.network.mockReset(); state.balance.mockReset() })
const weth = new Interface(['function deposit() payable', 'event Deposit(address indexed dst, uint256 wad)'])
function fixture() {
  const chain = { network: 8453n, code: '0x', blockHash: id('block'), head: 101, finalized: 99,
    tx: undefined as any, receipt: undefined as any }
  const block = (tag: string | number) => ({ number: typeof tag === 'number' ? tag : tag === 'finalized' ? chain.finalized : chain.head,
    hash: chain.blockHash })
  const provider = { getNetwork: async () => ({ chainId: chain.network }), getCode: async () => chain.code,
    getTransactionCount: async () => 7,
    getTransaction: async () => chain.tx, getTransactionReceipt: async () => chain.receipt,
    getBlock: async (tag: string | number) => block(tag),
    send: vi.fn(async (method: string, params: unknown[]): Promise<unknown> => {
      expect(method).toBe('eth_getBlockByNumber'); expect(params[1]).toBe(false)
      const header = block(params[0] === 'latest' || params[0] === 'finalized' ? params[0] : Number(BigInt(String(params[0]))))
      return { ...header, number: `0x${header.number.toString(16)}` }
    }) }
  const signer = { provider, getAddress: async () => payer, sendTransaction: vi.fn(async (tx: any) => {
    expect(state.saved).toEqual(expect.arrayContaining([expect.objectContaining({ payer, nonce: 7, amount: '123' })]))
    chain.tx = { ...tx, from: payer, hash: id('wrap'), blockHash: id('block'), blockNumber: 100 }
    const log = weth.encodeEventLog(weth.getEvent('Deposit')!, [payer, 123n])
    chain.receipt = { hash: id('wrap'), blockHash: id('block'), blockNumber: 100, status: 1, logs: [{ address: wrapped, ...log }] }
    return { hash: id('wrap'), nonce: tx.nonce }
  }) } as unknown as JsonRpcSigner
  return { chain, signer, provider, session: { provider } as unknown as WalletSession }
}

it('only requests a direct public type2 wrap and requires its exact deposit receipt', async () => {
  const f = fixture()
  await wrapBaseNative(f.session, f.signer, 123n)
  const saved = await savedBaseWrap(f.session)
  expect(saved!.data).toMatch(/^0xd0e30db0[0-9a-f]{64}$/)
  expect(f.signer.sendTransaction).toHaveBeenCalledExactlyOnceWith({ type: 2, chainId: 8453n, nonce: 7,
    to: wrapped, value: 123n, data: saved!.data })
  await expect(checkBaseWrap(f.session)).resolves.toEqual({ hash: id('wrap'), state: 'wrapped', amount: 123n })
  expect(await savedBaseWrap(f.session)).toBeUndefined()
})

it('preserves unknown submission and recovers a lost response by hash without sending again', async () => {
  const f = fixture(), send = vi.mocked(f.signer.sendTransaction).getMockImplementation()!
  vi.mocked(f.signer.sendTransaction).mockImplementation(async tx => { await send(tx); throw new Error('response lost') })
  await expect(wrapBaseNative(f.session, f.signer, 123n)).rejects.toThrow('response lost')
  await expect(wrapBaseNative(f.session, f.signer, 123n)).rejects.toThrow('saved wrap')
  await expect(checkBaseWrap(f.session)).rejects.toThrow('hash')
  await expect(checkBaseWrap(f.session, id('wrap'))).resolves.toMatchObject({ state: 'wrapped' })
  expect(f.signer.sendTransaction).toHaveBeenCalledTimes(1)
})

it.each(['from', 'to', 'chain', 'amount', 'data', 'authorization', 'type', 'event', 'block', 'confirmation'])
('preserves recovery for a substituted or unconfirmed %s', async field => {
  const f = fixture(); await wrapBaseNative(f.session, f.signer, 123n)
  if (field === 'from') f.chain.tx.from = other
  if (field === 'to') f.chain.tx.to = other
  if (field === 'chain') f.chain.tx.chainId = 1n
  if (field === 'amount') f.chain.tx.value++
  if (field === 'data') f.chain.tx.data = '0x'
  if (field === 'authorization') f.chain.tx.authorizationList = [{}]
  if (field === 'type') f.chain.tx.type = 4
  if (field === 'event') f.chain.receipt.logs = []
  if (field === 'block') f.chain.blockHash = id('reorg')
  if (field === 'confirmation') f.chain.head = 100
  await expect(checkBaseWrap(f.session)).rejects.toThrow()
  expect(await savedBaseWrap(f.session)).toMatchObject({ amount: '123' })
})

it.each(['cancelled', 'failed'])('waits for finality before clearing a %s wrap', async outcome => {
  const f = fixture(); await wrapBaseNative(f.session, f.signer, 123n)
  if (outcome === 'cancelled') Object.assign(f.chain.tx, { to: payer, value: 0n, data: '0x' })
  else f.chain.receipt.status = 0
  await expect(checkBaseWrap(f.session)).rejects.toThrow('finalize')
  f.chain.finalized = 100
  await expect(checkBaseWrap(f.session)).resolves.toMatchObject({ state: outcome })
  expect(await savedBaseWrap(f.session)).toBeUndefined()
})

it.each(['wrong network', 'contract payer', 'wallet change', 'insufficient balance'])('does not send after %s', async reason => {
  const f = fixture()
  if (reason === 'wrong network') f.chain.network = 1n
  if (reason === 'contract payer') f.chain.code = '0x1234'
  if (reason === 'wallet change') state.network.mockRejectedValue(new Error('changed'))
  if (reason === 'insufficient balance') state.balance.mockRejectedValue(new Error('balance'))
  await expect(wrapBaseNative(f.session, f.signer, 123n)).rejects.toThrow()
  expect(f.signer.sendTransaction).not.toHaveBeenCalled()
  expect(state.saved).toBeUndefined()
})

it('accepts an exact delegated payer without asking for its external authorization', async () => {
  const f = fixture(); f.chain.code = `0xef0100${other.slice(2)}`
  await wrapBaseNative(f.session, f.signer, 123n)
  expect(f.signer.sendTransaction).toHaveBeenCalledTimes(1)
})

it('preserves an explicit wallet rejection for later recovery and checks the callback before disclosure', async () => {
  const f = fixture()
  vi.mocked(f.signer.sendTransaction).mockRejectedValue({ code: 4001 })
  await expect(wrapBaseNative(f.session, f.signer, 123n)).rejects.toMatchObject({ code: 4001 })
  expect(await savedBaseWrap(f.session)).toBeUndefined()
  expect(await baseWrapRecords(f.session)).toHaveLength(1)
  vi.mocked(f.signer.sendTransaction).mockClear()
  await expect(wrapBaseNative(f.session, f.signer, 123n, () => { throw new Error('changed') })).rejects.toThrow('changed')
  expect(f.signer.sendTransaction).not.toHaveBeenCalled()
})

it.each([0, 2])('recovers the unique wrap intent when the wallet chooses nonce8 and transaction type%s', async type => {
  const f = fixture(); await wrapBaseNative(f.session, f.signer, 123n)
  f.chain.tx.nonce = 8; f.chain.tx.type = type
  await expect(checkBaseWrap(f.session)).resolves.toMatchObject({ state: 'wrapped' })
})

it('does not mistake another equal-value wrap for the saved intent', async () => {
  const f = fixture(); await wrapBaseNative(f.session, f.signer, 123n)
  f.chain.tx.data = weth.encodeFunctionData('deposit') + '33'.repeat(32)
  await expect(checkBaseWrap(f.session)).rejects.toThrow('saved wrap')
  expect(await savedBaseWrap(f.session)).toBeDefined()
})

it('can set an unknown wrap aside without erasing its later recovery or blocking another explicit payment', async () => {
  const f = fixture(); await wrapBaseNative(f.session, f.signer, 123n)
  const old = structuredClone({ tx: f.chain.tx, receipt: f.chain.receipt })
  await deferBaseWrap(f.session)
  expect(await savedBaseWrap(f.session)).toBeUndefined()
  await wrapBaseNative(f.session, f.signer, 123n)
  expect(await baseWrapRecords(f.session)).toHaveLength(2)
  Object.assign(f.chain, old)
  await expect(checkBaseWrap(f.session, id('wrap'))).resolves.toMatchObject({ state: 'wrapped' })
  expect(await savedBaseWrap(f.session)).toBeDefined()
  expect(await baseWrapRecords(f.session)).toHaveLength(1)
})

it.each(['wrapped', 'cancelled', 'failed'])('preserves a %s wrap when actual ethers cached an orphaned receipt block', async outcome => {
  const f = fixture(); await wrapBaseNative(f.session, f.signer, 123n)
  if (outcome === 'cancelled') Object.assign(f.chain.tx, { to: payer, value: 0n, data: '0x' })
  if (outcome === 'failed') f.chain.receipt.status = 0
  const saved = structuredClone(state.saved), rpc = new JsonRpcProvider(undefined, 8453, { staticNetwork: true })
  let reorg = false
  vi.spyOn(rpc, 'send').mockImplementation(async (_method, params) => {
    const tag = (params as unknown[])[0], number = tag === 'latest' ? 101 : tag === 'finalized' ? 100 : Number(BigInt(String(tag)))
    return { number: `0x${number.toString(16)}`, hash: number === 100 && reorg ? id('orphan replacement') : id('block'),
      parentHash: ZeroHash, timestamp: '0x1', nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1', gasUsed: '0x0',
      miner: null, extraData: '0x', transactions: [] }
  })
  try {
    await rpc.getBlock(100)
    reorg = true
    f.provider.getBlock = async tag => (await rpc.getBlock(tag))! as { number: number; hash: string }
    f.provider.send.mockImplementation((method, params) => rpc.send(method, params))
    await expect(checkBaseWrap(f.session)).rejects.toThrow(/canonical|history changed/)
    expect(state.saved).toEqual(saved)
    expect(f.signer.sendTransaction).toHaveBeenCalledOnce()
  } finally { rpc.destroy() }
})

it.each(['cancelled', 'failed'])('repins the finalized anchor before removing a %s wrap', async outcome => {
  const f = fixture(); await wrapBaseNative(f.session, f.signer, 123n)
  if (outcome === 'cancelled') Object.assign(f.chain.tx, { to: payer, value: 0n, data: '0x' })
  else f.chain.receipt.status = 0
  f.chain.finalized = 101; f.chain.head = 103
  const saved = structuredClone(state.saved), send = f.provider.send.getMockImplementation()!
  f.provider.send.mockImplementation(async (method, params) => params[0] === '0x65'
    ? { number: '0x65', hash: id('changed finalized branch') } : send(method, params))
  await expect(checkBaseWrap(f.session)).rejects.toThrow(/history changed/)
  expect(state.saved).toEqual(saved)
})

it('keeps a successful wrap if its two-confirmation head changes before cleanup', async () => {
  const f = fixture(); await wrapBaseNative(f.session, f.signer, 123n)
  const saved = structuredClone(state.saved), send = f.provider.send.getMockImplementation()!
  f.provider.send.mockImplementation(async (method, params) => params[0] === '0x65'
    ? { number: '0x65', hash: id('changed latest head') } : send(method, params))
  await expect(checkBaseWrap(f.session)).rejects.toThrow(/history changed/)
  expect(state.saved).toEqual(saved)
})
