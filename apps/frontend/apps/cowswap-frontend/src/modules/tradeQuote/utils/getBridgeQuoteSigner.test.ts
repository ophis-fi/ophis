import { areAddressesEqual, SupportedChainId } from '@cowprotocol/cow-sdk'

import {
  BRIDGE_QUOTE_ACCOUNT,
  BRIDGE_QUOTE_PRIVATE_KEY_STORAGE_KEY,
  getBridgeQuoteSigner,
  LEGACY_BRIDGE_QUOTE_ACCOUNT,
} from './getBridgeQuoteSigner'

describe('getBridgeQuoteSigner', () => {
  it('never uses the legacy published account (EIP-7702-delegated by sweeper bots on mainnet and Base)', () => {
    expect(areAddressesEqual(BRIDGE_QUOTE_ACCOUNT, LEGACY_BRIDGE_QUOTE_ACCOUNT)).toBe(false)
    expect(BRIDGE_QUOTE_ACCOUNT).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('uses one stable account for every chain in the runtime', () => {
    const mainnet = getBridgeQuoteSigner(SupportedChainId.MAINNET)
    const base = getBridgeQuoteSigner(SupportedChainId.BASE)

    expect(mainnet.address).toBe(BRIDGE_QUOTE_ACCOUNT)
    expect(base.address).toBe(BRIDGE_QUOTE_ACCOUNT)
    // Cached per chain, each bound to that chain's RPC provider.
    expect(getBridgeQuoteSigner(SupportedChainId.MAINNET)).toBe(mainnet)
    expect(mainnet.provider).not.toBe(base.provider)
  })

  it('persists the generated key so the quote account survives a reload', () => {
    const stored = window.localStorage.getItem(BRIDGE_QUOTE_PRIVATE_KEY_STORAGE_KEY)

    expect(stored).not.toBeNull()
    expect(JSON.parse(stored as string)).toBe(getBridgeQuoteSigner(SupportedChainId.MAINNET).privateKey)
  })
})
