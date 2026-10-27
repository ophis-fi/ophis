import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ init: vi.fn() }))
vi.mock('@walletconnect/ethereum-provider', () => ({ EthereumProvider: { init: mocks.init } }))

let provider: ReturnType<typeof fakeProvider>
let elements: Record<string, ReturnType<typeof fakeElement>>
function fakeElement() {
  return {
    open: false, value: '', src: '', textContent: '',
    onclick: null as null | (() => void),
    oncancel: null as null | ((event: { preventDefault: () => void }) => void),
    showModal() { this.open = true },
    close() { this.open = false },
    removeAttribute() { this.src = '' },
  }
}
function fakeProvider() {
  return Object.assign(new EventEmitter(), {
    session: undefined as undefined | { topic: string },
    chainId: 1, accounts: ['0x0000000000000000000000000000000000000001'],
    request: vi.fn().mockResolvedValue('wallet transaction hash'),
    connect: vi.fn<() => Promise<void>>(),
    disconnect: vi.fn().mockImplementation(async () => { provider.session = undefined }),
    signer: { cleanupPendingPairings: vi.fn().mockResolvedValue(undefined), client: { ping: vi.fn().mockResolvedValue(undefined) } },
  })
}
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', 'public-test-project')
  vi.stubEnv('VITE_RAILGUN_ENVIRONMENT', 'ethereum')
  elements = Object.fromEntries([
    'walletconnect-dialog', 'walletconnect-qr', 'walletconnect-link', 'walletconnect-copy', 'walletconnect-cancel', 'error',
  ].map((id) => [id, fakeElement()]))
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', { getElementById: (id: string) => elements[id] })
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:4322' })
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  provider = fakeProvider()
  mocks.init.mockReset().mockResolvedValue(provider)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('forwards transaction requests directly even when the optional session ping would stall', async () => {
  provider.session = { topic: 'connected-wallet' }
  provider.signer.client.ping.mockImplementation(() => new Promise(() => {}))
  const forward = provider.request
  const { connectPublicWallet } = await import('./public-connection')
  const connected = await connectPublicWallet('walletconnect')
  expect(connected.request).toBe(forward)
  const args = { method: 'eth_sendTransaction', params: [{ from: provider.accounts[0], to: 'relay', value: '0x1' }] }
  expect(await connected.request(args)).toBe('wallet transaction hash')
  expect(forward).toHaveBeenCalledExactlyOnceWith(args)
  expect(provider.signer.client.ping).not.toHaveBeenCalled()
})

it('keeps a transaction awaiting wallet approval pending beyond the old ping deadline without retrying', async () => {
  vi.useFakeTimers()
  provider.session = { topic: 'connected-wallet' }
  let complete: ((hash: string) => void) | undefined
  provider.request.mockImplementationOnce(() => new Promise<string>((resolve) => { complete = resolve }))
  const forward = provider.request
  const { connectPublicWallet } = await import('./public-connection')
  const connected = await connectPublicWallet('walletconnect')
  let settled = false
  const pending = connected.request({ method: 'eth_sendTransaction', params: [] }).then((result) => { settled = true; return result })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(settled).toBe(false)
  expect(forward).toHaveBeenCalledTimes(1)
  complete?.('approved transaction hash')
  expect(await pending).toBe('approved transaction hash')
  expect(forward).toHaveBeenCalledTimes(1)
})

it('propagates the SDK request rejection without submitting it again', async () => {
  provider.session = { topic: 'connected-wallet' }
  provider.request.mockRejectedValueOnce(new Error('Wallet rejected the request'))
  const forward = provider.request
  const { connectPublicWallet } = await import('./public-connection')
  const connected = await connectPublicWallet('walletconnect')
  await expect(connected.request({ method: 'eth_sendTransaction', params: [] })).rejects.toThrow('Wallet rejected the request')
  expect(forward).toHaveBeenCalledTimes(1)
})

it('rejects WalletConnect in a fork build before opening the relay, whose read RPC cannot attest the remote signer network', async () => {
  vi.stubEnv('VITE_RAILGUN_ENVIRONMENT', 'fork')
  const { connectPublicWallet } = await import('./public-connection')
  await expect(connectPublicWallet('walletconnect')).rejects.toThrow('unavailable in fork mode')
  expect(mocks.init).not.toHaveBeenCalled()
})

it('keeps browser wallets independent and gives a WalletConnect alternative when no extension exists', async () => {
  const { connectPublicWallet } = await import('./public-connection')
  await expect(connectPublicWallet('browser')).rejects.toThrow('Use WalletConnect')
  const injected = { request: vi.fn() }
  window.ethereum = injected
  expect(await connectPublicWallet('browser')).toBe(injected)
  expect(mocks.init).not.toHaveBeenCalled()
})

it('uses the trusted same-origin RPC and no telemetry, signs nothing, and removes the pairing secret on success', async () => {
  const uri = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`
  provider.connect.mockImplementation(async () => {
    provider.emit('display_uri', uri)
    expect(elements['walletconnect-dialog'].open).toBe(true)
    expect(elements['walletconnect-qr'].src).toMatch(/^data:image\/gif;base64,/)
    expect(elements['walletconnect-link'].value).toBe(uri)
    elements['walletconnect-copy'].onclick?.()
    provider.session = { topic: 'approved' }
  })
  const { connectPublicWallet } = await import('./public-connection')
  expect(await connectPublicWallet('walletconnect')).toBe(provider)
  expect(mocks.init).toHaveBeenCalledWith(expect.objectContaining({
    optionalChains: [1], optionalMethods: ['eth_sendTransaction', 'wallet_switchEthereumChain'],
    rpcMap: { 1: 'http://127.0.0.1:4322/rpc' }, telemetryEnabled: false, showQrModal: false,
    metadata: expect.objectContaining({ url: 'http://127.0.0.1:4322' }),
  }))
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(uri)
  expect(elements['walletconnect-dialog'].open).toBe(false)
  expect(elements['walletconnect-link'].value).toBe('')
  expect(elements['walletconnect-qr'].src).toBe('')
  expect(provider.listenerCount('display_uri')).toBe(0)
  await connectPublicWallet('walletconnect')
  expect(mocks.init).toHaveBeenCalledTimes(1)
  expect(provider.connect).toHaveBeenCalledTimes(1)
})

it.each(['button', 'escape'])('cancels through %s without resuming the action and permits a new pairing', async (kind) => {
  provider.connect.mockImplementationOnce(() => new Promise(() => {}))
  const { connectPublicWallet } = await import('./public-connection')
  const pending = connectPublicWallet('walletconnect')
  const rejected = expect(pending).rejects.toThrow('cancelled')
  await vi.waitFor(() => expect(provider.connect).toHaveBeenCalledTimes(1))
  if (kind === 'button') elements['walletconnect-cancel'].onclick?.()
  else elements['walletconnect-dialog'].oncancel?.({ preventDefault: vi.fn() })
  await rejected
  expect(provider.signer.cleanupPendingPairings).toHaveBeenCalledWith({ deletePairings: true })
  expect(elements['walletconnect-dialog'].open).toBe(false)
  expect(provider.listenerCount('display_uri')).toBe(0)
  provider.connect.mockImplementationOnce(async () => { provider.session = { topic: 'retried' } })
  expect(await connectPublicWallet('walletconnect')).toBe(provider)
  expect(provider.connect).toHaveBeenCalledTimes(2)
  expect(mocks.init).toHaveBeenCalledTimes(2)
  expect(mocks.init.mock.calls[0][0].customStoragePrefix).not.toBe(mocks.init.mock.calls[1][0].customStoragePrefix)
})

it('discards a late cancelled approval without disconnecting or replacing a successful retry', async () => {
  const old = provider
  let finish: (() => void) | undefined
  old.connect.mockImplementation(async () => {
    await new Promise<void>((resolve) => { finish = resolve })
    old.session = { topic: 'late-cancelled-session' }
  })
  old.disconnect.mockImplementation(async () => { old.session = undefined })
  const { connectPublicWallet } = await import('./public-connection')
  const first = connectPublicWallet('walletconnect')
  const rejected = expect(first).rejects.toThrow('cancelled')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  elements['walletconnect-cancel'].onclick?.()
  await rejected
  const next = fakeProvider()
  mocks.init.mockResolvedValueOnce(next)
  next.connect.mockImplementation(async () => { next.session = { topic: 'new-session' } })
  expect(await connectPublicWallet('walletconnect')).toBe(next)
  finish?.()
  await vi.waitFor(() => expect(old.disconnect).toHaveBeenCalledTimes(1))
  expect(old.session).toBeUndefined()
  expect(next.session?.topic).toBe('new-session')
  expect(next.disconnect).not.toHaveBeenCalled()
  expect(await connectPublicWallet('walletconnect')).toBe(next)
})

it('retries initialization failures and rejects a missing project ID before opening the relay', async () => {
  const { connectPublicWallet } = await import('./public-connection')
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', '')
  await expect(connectPublicWallet('walletconnect')).rejects.toThrow('not configured')
  expect(mocks.init).not.toHaveBeenCalled()
  vi.stubEnv('VITE_WALLETCONNECT_PROJECT_ID', 'public-test-project')
  mocks.init.mockRejectedValueOnce(new Error('Relay unavailable'))
  await expect(connectPublicWallet('walletconnect')).rejects.toThrow('Relay unavailable')
  provider.connect.mockImplementation(async () => { provider.session = { topic: 'retried' } })
  expect(await connectPublicWallet('walletconnect')).toBe(provider)
  expect(mocks.init).toHaveBeenCalledTimes(2)
})

it('honors cancellation even when storage fails, discards late approval, and blocks retry until isolation can be saved', async () => {
  let finish: (() => void) | undefined
  provider.connect.mockImplementation(async () => {
    await new Promise<void>((resolve) => { finish = resolve })
    provider.session = { topic: 'late-approval' }
  })
  const { connectPublicWallet } = await import('./public-connection')
  const first = connectPublicWallet('walletconnect')
  const rejected = expect(first).rejects.toThrow('cancelled')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
  expect(() => elements['walletconnect-cancel'].onclick?.()).not.toThrow()
  await rejected
  finish?.()
  await vi.waitFor(() => expect(provider.disconnect).toHaveBeenCalledTimes(1))
  await expect(connectPublicWallet('walletconnect')).rejects.toThrow('browser storage')
  expect(mocks.init).toHaveBeenCalledTimes(1)
  write.mockRestore()
  provider.connect.mockImplementation(async () => { provider.session = { topic: 'retried' } })
  expect(await connectPublicWallet('walletconnect')).toBe(provider)
  expect(mocks.init).toHaveBeenCalledTimes(2)
})
