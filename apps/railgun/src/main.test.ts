import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  persisted: false, failRead: false, open: vi.fn(), setup: vi.fn(), sync: vi.fn(),
  provider: {}, wire: vi.fn(), funding: vi.fn(), report: undefined as ((message: string, ready: boolean) => void) | undefined,
}))
vi.mock('./wallet', () => ({ newMnemonic: () => 'disposable test phrase',
  openWallet: mocks.open, syncWallet: mocks.sync,
  startWalletEngine: async (_balance: unknown, report: typeof mocks.report) => { mocks.report = report; return mocks.provider } }))
vi.mock('./wallet-actions', () => ({ wireWalletActions: mocks.wire }))
vi.mock('./network-ui', () => ({ configurePrivateSelectors: vi.fn() }))
vi.mock('./embedded', () => ({ reportEmbeddedLayout: vi.fn() }))
vi.mock('./pickers', () => ({ configurePickers: () => () => {} }))
vi.mock('./wallet-layout', () => ({ configureWalletLayout: vi.fn(), showSetup: mocks.setup,
  startFirstFunding: vi.fn(), updateFirstFunding: mocks.funding }))
vi.mock('./storage', () => ({ readPreference: async () => {
  if (mocks.failRead) throw new Error('Storage unavailable')
  return mocks.persisted ? { id: 'fixture-wallet', salt: 'fixture-salt' } : undefined
} }))
vi.mock('./config', () => ({ CHAIN_NAME: 'Ethereum', ENVIRONMENT: 'fork', TOKENS: {} }))

type Field = { value: string; hidden: boolean; disabled: boolean; checked: boolean; textContent: string;
  title: string; onclick?: () => Promise<void> | void; oninput?: () => void; addEventListener: () => void; focus: () => void; removeAttribute: () => void }
let fields: Record<string, Field>
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  mocks.persisted = false; mocks.failRead = false
  mocks.open.mockReset(); mocks.sync.mockReset().mockResolvedValue(undefined)
  mocks.wire.mockReset().mockResolvedValue(undefined); mocks.report = undefined
  mocks.funding.mockReset()
  fields = new Proxy({} as Record<string, Field>, { get: (target, id: string) => target[id] ??= {
    value: '', hidden: false, disabled: false, checked: false, textContent: '', title: '', addEventListener: () => {}, focus: vi.fn(), removeAttribute: () => {},
  } })
  vi.stubGlobal('document', { documentElement: { dataset: {} },
    getElementById: (id: string) => fields[id], querySelectorAll: () => [fields['private-network']] })
  vi.stubGlobal('location', { reload: vi.fn() })
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
  expect(fields['setup-help'].textContent).toContain('do not clear site data')
  expect(fields['setup-back'].textContent).toBe('Reload wallet')
  await fields['setup-back'].onclick?.()
  expect(location.reload).toHaveBeenCalledOnce()
  expect(mocks.open).not.toHaveBeenCalled()
})

it('preserves transaction results through sync progress and completion', async () => {
  await import('./main')
  await vi.dynamicImportSettled()
  fields.status.textContent = 'Withdrawal confirmed: test-hash'
  mocks.report?.('Synchronizing private history.', false)
  expect(fields.status.textContent).toBe('Withdrawal confirmed: test-hash')
  expect(fields['balance-sync'].textContent).toBe('Synchronizing private history.')
  expect(fields['history-announcement'].textContent).toBe('Synchronizing private history.')
  mocks.report?.('Synchronizing private history: 50%', false)
  expect(fields['history-announcement'].textContent).toBe('Synchronizing private history.')
  mocks.funding.mockImplementation((_funds: boolean, ready: boolean) => {
    if (ready) expect(fields['ready-actions'].disabled).toBe(false)
  })
  mocks.report?.('Complete · private balances are ready.', true)
  expect(fields.status.textContent).toBe('Withdrawal confirmed: test-hash')
  expect(fields['balance-sync'].hidden).toBe(true)
  expect(fields['history-announcement'].textContent).toBe('Complete · private balances are ready.')
})

it('hides inactive wallet controls and offers a safe reload when saved transaction setup fails', async () => {
  mocks.persisted = true
  mocks.open.mockResolvedValue({ info: { id: 'fixture-wallet', railgunAddress: 'fixture-address' } })
  mocks.wire.mockRejectedValueOnce(new Error('Journal decryption failed'))
  await import('./main')
  await vi.dynamicImportSettled()
  await fields.unlock.onclick?.()
  expect(fields.wallet.hidden).toBe(true)
  expect(fields.setup.hidden).toBe(false)
  expect(fields.unlock.hidden).toBe(true)
  expect(fields['setup-back'].textContent).toBe('Lock and retry')
  expect(fields['private-network'].disabled).toBe(true)
  expect(fields.error.textContent).toContain('your saved data has not been cleared')
  expect(mocks.sync).not.toHaveBeenCalled()
  await fields['setup-back'].onclick?.()
  expect(location.reload).toHaveBeenCalledOnce()
})
