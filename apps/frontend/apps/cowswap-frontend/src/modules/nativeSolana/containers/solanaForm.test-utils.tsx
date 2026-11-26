import { createStore, Provider } from 'jotai'
import type { ReactNode } from 'react'

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render } from '@testing-library/react'
import { queryClientAtom } from 'jotai-tanstack-query'

import { NativeSolanaForm } from './NativeSolanaForm.container'

export { fetchOphisNativeSellReserve, solanaAddress } from '@ophis/solana-sdk'
export { solanaConnectionAtom } from 'entities/solana'

jest.mock(
  '@ophis/solana-sdk',
  () => ({
    SOLANA_NATIVE_ASSET: '11111111111111111111111111111111',
    WRAPPED_SOL_MINT: 'So11111111111111111111111111111111111111112',
    solanaAddress: (value: string) => {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw Error('Invalid address')
      return value
    },
    fetchOphisNativeSellReserve: jest.fn().mockResolvedValue(2646600n),
    fetchOphisWalletHoldings: async () => [
      { mint: '11111111111111111111111111111111', atoms: 2822552n, decimals: 9 },
      { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', atoms: 123n, decimals: 2 },
    ],
    parseOphisSolanaAmount: (value: string, decimals: number) => BigInt(Math.round(Number(value) * 10 ** decimals)),
    OphisSolanaHttpError: class extends Error {},
    formatOphisSolanaAmount: (atoms: bigint, decimals: number) => String(Number(atoms) / 10 ** decimals),
  }),
  { virtual: true },
)
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { api: 'https://example.test', chain: 'solana:mainnet', genesis: 'mainnet' },
  solanaConnectionAtom: jest
    .requireActual('jotai')
    .atom({ wallet: { name: 'Test wallet' }, account: { address: '11111111111111111111111111111111' } }),
  solanaWalletsAtom: jest.requireActual('jotai').atom([]),
  solanaWalletBusyAtom: jest.requireActual('jotai').atom(false),
  solanaWalletErrorAtom: jest.requireActual('jotai').atom(null),
}))
jest.mock('modules/networkSelector', () => ({ NetworkSelector: () => null }))
jest.mock('./SolanaWalletConnect.container', () => ({ SolanaWalletConnect: () => null }))
jest.mock('ophis/components/AssetSwap/AssetSwapFields', () => ({
  AssetSwapFieldsLayout: ({ input, output }: { input: ReactNode; output: ReactNode }) => (
    <>
      {input}
      {output}
    </>
  ),
}))

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
})

export function renderForm(onReview = jest.fn()): ReturnType<typeof createStore> {
  HTMLDialogElement.prototype.showModal = function (): void {
    this.open = true
  }
  const store = createStore()
  store.get(queryClientAtom).clear()
  render(
    <Provider store={store}>
      <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
        <NativeSolanaForm onReview={onReview} />
      </I18nProvider>
    </Provider>,
  )
  return store
}
