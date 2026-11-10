import { beforeEach, expect, it, vi } from 'vitest'
import { encodeBytes32String, getAddress, Interface, ZeroAddress, zeroPadValue, toBeHex } from 'ethers'
import type { WalletSession } from './wallet'
import type { PrivateToken } from './networks'

const state = vi.hoisted(() => ({
  saved: new Map<string, unknown>(), registry: new Map<string, PrivateToken>(), events: [] as string[],
  read: vi.fn(), write: vi.fn(), register: vi.fn(),
}))
vi.mock('./config', () => ({
  CHAIN: 56n, CHAIN_ID: 56,
  tokenIdFor: (address: string) => [...state.registry.keys()].find(id => getAddress(state.registry.get(id)!.address) === getAddress(address)),
  tokenFor: (id: string) => state.registry.get(id),
  registerToken: state.register,
}))
vi.mock('./storage', () => ({ readPrivateState: state.read, writePrivateState: state.write }))
import { importPrivateToken, loadTokenCatalog } from './token-catalog'

const KEY = 'tokenCatalog:v1'
const ADDRESS = '0x0000000000000000000000000000000000001234'
const OTHER = '0x0000000000000000000000000000000000005678'
const metadata = new Interface(['function decimals() view returns (uint8)', 'function symbol() view returns (string)'])
const getNetwork = vi.fn(), getBlockNumber = vi.fn(), getCode = vi.fn(), call = vi.fn()
const session = (id = 'wallet-a'): WalletSession => ({ info: { id }, provider: { getNetwork, getBlockNumber, getCode, call } }) as unknown as WalletSession
const stored = (tokens: PrivateToken[], chainId = 56) => ({ version: 1, chainId, tokens })

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  state.saved.clear(); state.registry.clear(); state.events.length = 0
  state.read.mockImplementation(async (wallet: WalletSession, key: string) => state.saved.get(`${wallet.info.id}:${key}`))
  state.write.mockImplementation(async (wallet: WalletSession, key: string, value: unknown) => {
    state.events.push('persist'); state.saved.set(`${wallet.info.id}:${key}`, value)
  })
  state.register.mockImplementation((token: PrivateToken) => {
    state.events.push('register'); state.registry.set(token.address.toLowerCase(), token); return token.address.toLowerCase()
  })
  getNetwork.mockResolvedValue({ chainId: 56n }); getBlockNumber.mockResolvedValue(100); getCode.mockResolvedValue('0x6000')
  call.mockImplementation(async (request: { data: string }) => request.data === metadata.encodeFunctionData('decimals')
    ? metadata.encodeFunctionResult('decimals', [18]) : metadata.encodeFunctionResult('symbol', ['TEST']))
})

it('imports a contract by address, pins bounded metadata reads and persists encrypted state before registration', async () => {
  expect(await importPrivateToken(session(), ADDRESS)).toBe(ADDRESS)
  expect(state.events).toEqual(['persist', 'register'])
  expect(state.write).toHaveBeenCalledWith(session(), KEY, stored([{ address: ADDRESS, decimals: 18, symbol: 'TEST' }]))
  expect(getCode).toHaveBeenCalledWith(ADDRESS, 100)
  expect(call.mock.calls).toHaveLength(2)
  for (const [request] of call.mock.calls) expect(request).toMatchObject({ to: ADDRESS, gasLimit: 150_000n, blockTag: 100 })
})

it('loads only its wallet record and validates the entire catalog before registering any entry', async () => {
  state.saved.set(`wallet-b:${KEY}`, stored([{ address: OTHER, decimals: 6, symbol: 'OTHER' }]))
  await loadTokenCatalog(session())
  expect(state.registry.size).toBe(0)
  await loadTokenCatalog(session('wallet-b'))
  expect(state.registry.get(OTHER)?.symbol).toBe('OTHER')
  state.register.mockClear(); state.registry.clear()
  state.saved.set(`wallet-a:${KEY}`, stored([{ address: ADDRESS, decimals: 18, symbol: 'GOOD' },
    { address: OTHER, decimals: 18, symbol: 'bad\u202e' }]))
  await expect(loadTokenCatalog(session())).rejects.toThrow('metadata is invalid')
  expect(state.register).not.toHaveBeenCalled()
  expect(state.write).not.toHaveBeenCalled()
})

it('refuses the wrong chain, duplicate addresses, malformed records and changed saved decimals without mutation', async () => {
  for (const value of [null, { version: 2, chainId: 56, tokens: [] }, stored([], 1),
    stored([{ address: ADDRESS, decimals: 18, symbol: 'A' }, { address: ADDRESS, decimals: 18, symbol: 'B' }])]) {
    state.saved.set(`wallet-a:${KEY}`, value)
    await expect(loadTokenCatalog(session())).rejects.toThrow()
  }
  state.registry.set(ADDRESS, { address: ADDRESS, decimals: 6, symbol: 'PINNED' })
  state.saved.set(`wallet-a:${KEY}`, stored([{ address: ADDRESS, decimals: 18, symbol: 'A' }]))
  await expect(loadTokenCatalog(session())).rejects.toThrow('decimals changed')
  expect(state.register).not.toHaveBeenCalled(); expect(state.write).not.toHaveBeenCalled()
})

it.each([0, 77])('supports amount formatting decimals%d within the explicit integration bound', async (decimals) => {
  call.mockImplementation(async (request: { data: string }) => request.data === metadata.encodeFunctionData('decimals')
    ? metadata.encodeFunctionResult('decimals', [decimals]) : metadata.encodeFunctionResult('symbol', ['TEST']))
  await importPrivateToken(session(), ADDRESS)
  expect(state.registry.get(ADDRESS)?.decimals).toBe(decimals)
})

it.each([78, 80, 255])('rejects unsupported decimals%d before persistence or registration', async (decimals) => {
  call.mockImplementation(async (request: { data: string }) => request.data === metadata.encodeFunctionData('decimals')
    ? zeroPadValue(toBeHex(decimals), 32) : metadata.encodeFunctionResult('symbol', ['TEST']))
  await expect(importPrivateToken(session(), ADDRESS)).rejects.toThrow('0 to 77')
  expect(state.write).not.toHaveBeenCalled(); expect(state.register).not.toHaveBeenCalled()
})

it('rejects invalid addresses, missing contracts, wrong RPC network and metadata chain changes before registration', async () => {
  await expect(importPrivateToken(session(), 'not-an-address')).rejects.toThrow()
  await expect(importPrivateToken(session(), ZeroAddress)).rejects.toThrow('contract address')
  getCode.mockResolvedValueOnce('0x')
  await expect(importPrivateToken(session(), ADDRESS)).rejects.toThrow('No token contract')
  getNetwork.mockResolvedValueOnce({ chainId: 1n })
  await expect(importPrivateToken(session(), ADDRESS)).rejects.toThrow('selected private network')
  getNetwork.mockResolvedValueOnce({ chainId: 56n }).mockResolvedValueOnce({ chainId: 1n })
  await expect(importPrivateToken(session(), ADDRESS)).rejects.toThrow('selected private network')
  expect(state.write).not.toHaveBeenCalled(); expect(state.register).not.toHaveBeenCalled()
})

it('handles bytes32 symbols and falls back to an address label for absent, oversized or unsafe metadata', async () => {
  for (const raw of [encodeBytes32String('MKR'), '0x', metadata.encodeFunctionResult('symbol', ['x'.repeat(65)]),
    metadata.encodeFunctionResult('symbol', ['fake\u202eUSDC']), `0x${'ff'.repeat(600)}`]) {
    state.saved.clear(); state.registry.clear()
    call.mockImplementation(async (request: { data: string }) => request.data === metadata.encodeFunctionData('decimals')
      ? metadata.encodeFunctionResult('decimals', [18]) : raw)
    await importPrivateToken(session(), ADDRESS)
    expect(state.registry.get(ADDRESS)?.symbol).toBe(raw === encodeBytes32String('MKR') ? 'MKR' : '0x0000…1234')
  }
})

it('does not overwrite pinned metadata and rejects changed onchain decimals', async () => {
  state.registry.set(ADDRESS, { address: ADDRESS, decimals: 18, symbol: 'PINNED' })
  await importPrivateToken(session(), ADDRESS)
  expect(state.registry.get(ADDRESS)?.symbol).toBe('PINNED')
  call.mockImplementation(async (request: { data: string }) => request.data === metadata.encodeFunctionData('decimals')
    ? metadata.encodeFunctionResult('decimals', [6]) : metadata.encodeFunctionResult('symbol', ['RENAMED']))
  await expect(importPrivateToken(session(), ADDRESS)).rejects.toThrow('decimals changed')
  expect(state.write).toHaveBeenCalledTimes(1)
})

it('never registers an unpersisted import and remains usable after a failed write', async () => {
  state.write.mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(importPrivateToken(session(), ADDRESS)).rejects.toThrow('storage unavailable')
  expect(state.register).not.toHaveBeenCalled(); expect(state.saved.size).toBe(0)
  await importPrivateToken(session(), ADDRESS)
  expect(state.registry.size).toBe(1)
})

it('serializes imports and catalog loading so concurrent operations cannot lose another asset', async () => {
  let release: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { release = resolve })
  const first = state.write.getMockImplementation()!
  state.write.mockImplementationOnce(async (...args) => { await waiting; return first(...args) })
  const one = importPrivateToken(session(), ADDRESS)
  const loaded = loadTokenCatalog(session())
  const two = importPrivateToken(session(), OTHER)
  await vi.waitFor(() => expect(state.write).toHaveBeenCalledTimes(1))
  expect(state.register).not.toHaveBeenCalled()
  release!()
  await Promise.all([one, loaded, two])
  expect(state.saved.get(`wallet-a:${KEY}`)).toEqual(stored([
    { address: ADDRESS, decimals: 18, symbol: 'TEST' }, { address: OTHER, decimals: 18, symbol: 'TEST' },
  ]))
})

it('bounds an unresponsive metadata operation and releases its serialized queue after timeout', async () => {
  vi.useFakeTimers()
  getNetwork.mockImplementationOnce(() => new Promise(() => {}))
  const failed = expect(importPrivateToken(session(), ADDRESS)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(10_001)
  await failed
  vi.useRealTimers()
  await importPrivateToken(session(), ADDRESS)
  expect(state.registry.size).toBe(1)
})
