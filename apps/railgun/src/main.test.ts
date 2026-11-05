import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  persisted: false, failRead: false, open: vi.fn(), setup: vi.fn(), sync: vi.fn(),
  provider: {},
}))
vi.mock('./wallet', () => ({ newMnemonic: () => 'disposable test phrase',
  openWallet: mocks.open, syncWallet: mocks.sync, startWalletEngine: async () => mocks.provider }))
vi.mock('./wallet-actions', () => ({ wireWalletActions: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./network-ui', () => ({ configurePrivateSelectors: vi.fn() }))
vi.mock('./embedded', () => ({ reportEmbeddedLayout: vi.fn() }))
vi.mock('./pickers', () => ({ configurePickers: () => () => {} }))
vi.mock('./wallet-layout', () => ({ configureWalletLayout: vi.fn(), showSetup: mocks.setup,
  startFirstFunding: vi.fn(), updateFirstFunding: vi.fn() }))
vi.mock('./storage', () => ({ readPreference: async () => {
  if (mocks.failRead) throw new Error('Storage unavailable')
  return mocks.persisted ? { id: 'fixture-wallet', salt: 'fixture-salt' } : undefined
} }))
vi.mock('./config', () => ({ CHAIN_NAME: 'Ethereum', ENVIRONMENT: 'fork', TOKENS: {} }))

type Field = { value: string; hidden: boolean; disabled: boolean; checked: boolean; textContent: string;
  title: string; onclick?: () => Promise<void> | void; oninput?: () => void; addEventListener: () => void }
let fields: Record<string, Field>
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  mocks.persisted = false; mocks.failRead = false
  mocks.sync.mockResolvedValue(undefined)
  fields = new Proxy({} as Record<string, Field>, { get: (target, id: string) => target[id] ??= {
    value: '', hidden: false, disabled: false, checked: false, textContent: '', title: '', addEventListener: () => {},
  } })
  vi.stubGlobal('document', { documentElement: { dataset: {} },
    getElementById: (id: string) => fields[id], querySelectorAll: () => [fields['private-network']] })
})
afterEach(() => vi.unstubAllGlobals())

it('offers unlock after a first open persists metadata but fails, and keeps the network locked after retry', async () => {
  mocks.open.mockImplementationOnce(async () => { mocks.persisted = true; throw new Error('History scan interrupted') })
  await import('./main')
  await vi.dynamicImportSettled()
  expect(mocks.setup).toHaveBeenCalledWith(false)
  await fields.generate.onclick?.()
  fields.password.value = 'disposable-test-password'
  fields.backup.checked = true
  await fields.open.onclick?.()
  expect(mocks.setup).toHaveBeenLastCalledWith(true)
  expect(fields.error.textContent).toBe('History scan interrupted')
  expect(fields.password.value).toBe('')
  expect(fields.mnemonic.value).toBe('')
  expect(fields.backup.checked).toBe(false)
  mocks.open.mockResolvedValueOnce({ info: { id: 'fixture-wallet', railgunAddress: 'fixture-address' } })
  fields.password.value = 'disposable-test-password'
  await fields.unlock.onclick?.()
  expect(mocks.open).toHaveBeenLastCalledWith(mocks.provider, 'disposable-test-password', undefined, false)
  expect(fields['private-network'].disabled).toBe(true)
  expect(fields.wallet.hidden).toBe(false)
})

it('replaces the loading state with recovery guidance when metadata cannot be read', async () => {
  mocks.failRead = true
  await import('./main')
  await vi.dynamicImportSettled()
  expect(fields['setup-title'].textContent).toBe('Private wallet unavailable')
  expect(fields['setup-help'].textContent).toContain('fresh browser profile')
  expect(mocks.open).not.toHaveBeenCalled()
})
