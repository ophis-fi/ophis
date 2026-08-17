import type { EIP1193Provider, EIP6963ProviderDetail } from '@cowprotocol/types'

import {
  areEip6963RdnsEqual,
  findEip6963ProviderByRdns,
  isEip6963ProviderDetail,
  upsertEip6963Provider,
} from './eip6963Providers'

function createProvider(): EIP1193Provider {
  return { request: jest.fn() } as unknown as EIP1193Provider
}

function createDetail(rdns: string, uuid: string, provider = createProvider()): EIP6963ProviderDetail {
  return {
    info: { rdns, uuid, name: rdns, icon: 'data:image/svg+xml,<svg />' },
    provider,
  }
}

describe('EIP-6963 provider announcements', () => {
  it('accepts valid details and ignores malformed announcements', () => {
    const valid = createDetail('wallet.example', 'provider-1')
    const providers = [valid]

    expect(isEip6963ProviderDetail(valid)).toBe(true)
    expect(isEip6963ProviderDetail({ info: valid.info })).toBe(false)
    expect(upsertEip6963Provider(providers, { detail: valid })).toBe(providers)
  })

  it('adds late announcements without disturbing existing wallets', () => {
    const first = createDetail('first.example', 'provider-1')
    const late = createDetail('late.example', 'provider-2')

    expect(upsertEip6963Provider([first], late)).toEqual([late, first])
  })

  it('refreshes a provider object re-announced under the same RDNS', () => {
    const stale = createDetail('wallet.example', 'provider-1')
    const refreshed = createDetail('WALLET.EXAMPLE', 'provider-2')

    expect(upsertEip6963Provider([stale], refreshed)).toEqual([refreshed])
  })

  it('keeps an identical repeated announcement stable', () => {
    const detail = createDetail('wallet.example', 'provider-1')
    const providers = [detail]

    expect(upsertEip6963Provider(providers, detail)).toBe(providers)
  })

  it('resolves remembered providers case-insensitively and rejects malformed storage', () => {
    const detail = createDetail('Wallet.Example', 'provider-1')

    expect(findEip6963ProviderByRdns([detail], 'wallet.example')).toBe(detail)
    expect(areEip6963RdnsEqual(' Wallet.Example ', 'wallet.example')).toBe(true)
    expect(findEip6963ProviderByRdns([detail], { rdns: 'wallet.example' })).toBeNull()
    expect(findEip6963ProviderByRdns([], 'wallet.example')).toBeNull()
  })
})
