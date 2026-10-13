import { getIsLedgerLiveBrowser, getShouldConnectInjectedEagerly } from './connection'

afterEach(() => {
  delete window.ethereum
  jest.restoreAllMocks()
})

it('connects the injected wallet eagerly inside Ledger Wallet, but not for a desktop browser extension', () => {
  window.ethereum = { providers: [] }
  expect(getIsLedgerLiveBrowser()).toBe(false)
  expect(getShouldConnectInjectedEagerly()).toBe(false)

  window.ethereum = { isLedgerLive: true, providers: [] }
  expect(getIsLedgerLiveBrowser()).toBe(true)
  expect(getShouldConnectInjectedEagerly()).toBe(true)
})

it('ignores the Ledger flag inside an iframe (e.g. a Safe App)', () => {
  window.ethereum = { isLedgerLive: true, providers: [] }
  jest.spyOn(window, 'self', 'get').mockReturnValue({} as Window & typeof globalThis)

  expect(getIsLedgerLiveBrowser()).toBe(false)
  expect(getShouldConnectInjectedEagerly()).toBe(false)
})
