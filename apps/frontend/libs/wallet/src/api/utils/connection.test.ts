import { getIsLedgerLiveBrowser, getShouldConnectInjectedEagerly } from './connection'

afterEach(() => {
  delete window.ethereum
})

it('connects the injected wallet eagerly inside Ledger Wallet, but not for a desktop browser extension', () => {
  window.ethereum = { providers: [] }
  expect(getIsLedgerLiveBrowser()).toBe(false)
  expect(getShouldConnectInjectedEagerly()).toBe(false)

  window.ethereum = { isLedgerLive: true, providers: [] }
  expect(getIsLedgerLiveBrowser()).toBe(true)
  expect(getShouldConnectInjectedEagerly()).toBe(true)
})
