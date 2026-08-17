import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

import { getJotaiIsolatedStorage, jotaiStore } from '@cowprotocol/core'
import type { EIP6963ProviderDetail } from '@cowprotocol/types'

import { findEip6963ProviderByRdns, upsertEip6963Provider } from '../pure/eip6963Providers'

export const multiInjectedProvidersAtom = atom<EIP6963ProviderDetail[]>([])

// RDNS of the selected EIP-6963 provider
export const selectedEip6963ProviderRdnsAtom = atomWithStorage<string | null>(
  'selectedEip6963ProviderAtom:v0',
  null,
  getJotaiIsolatedStorage(),
)

export const selectedEip6963ProviderAtom = atom((get) => {
  const providers = get(multiInjectedProvidersAtom)
  const selectedProviderId = get(selectedEip6963ProviderRdnsAtom)

  return findEip6963ProviderByRdns(providers, selectedProviderId)
})

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event: Event) => {
    const announcement = Reflect.get(event, 'detail')

    jotaiStore.set(multiInjectedProvidersAtom, (prev: EIP6963ProviderDetail[]) =>
      upsertEip6963Provider(prev, announcement),
    )
  })

  window.dispatchEvent(new Event('eip6963:requestProvider'))
}
