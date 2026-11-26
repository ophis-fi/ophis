import { createStore, Provider } from 'jotai'
import type { ReactNode } from 'react'

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { solanaAddress } from '@ophis/solana-sdk'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { queryClientAtom } from 'jotai-tanstack-query'

import { NativeSolanaForm } from './NativeSolanaForm.container'

import { walletAssetListAtom } from '../state/assets.atoms'

const ray = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'
const orca = 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'
const pyth = 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'
const wsol = 'So11111111111111111111111111111111111111112'
jest.mock(
  '@ophis/solana-sdk',
  () => ({
    SOLANA_NATIVE_ASSET: '11111111111111111111111111111111',
    WRAPPED_SOL_MINT: 'So11111111111111111111111111111111111111112',
    solanaAddress: (value: string) => {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw Error('Invalid address')
      return value
    },
    fetchOphisWalletHoldings: async () => [
      { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', atoms: 123n, decimals: 2 },
    ],
    formatOphisSolanaAmount: (atoms: bigint, decimals: number) => String(Number(atoms) / 10 ** decimals),
  }),
  { virtual: true },
)
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { api: 'https://example.test', chain: 'solana:mainnet', genesis: 'mainnet' },
  solanaConnectionAtom: jest.requireActual('jotai').atom({ account: { address: '11111111111111111111111111111111' } }),
}))
jest.mock('modules/networkSelector', () => ({ NetworkSelector: () => null }))
jest.mock('./SolanaWalletAction.container', () => ({ SolanaWalletAction: () => null }))
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
})

function renderForm(): ReturnType<typeof createStore> {
  HTMLDialogElement.prototype.showModal = function (): void {
    this.open = true
  }
  const store = createStore()
  store.get(queryClientAtom).clear()
  render(
    <Provider store={store}>
      <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
        <NativeSolanaForm />
      </I18nProvider>
    </Provider>,
  )
  return store
}

it('loads the mainnet catalog on demand for both pickers and keeps selections keyed by mint', async () => {
  const tokens = [
    { address: ray, symbol: 'RAY', name: 'Raydium', decimals: 6, logoURI: 'https://untrusted.test/image' },
    { address: ray, symbol: 'Duplicate', name: 'Duplicate', decimals: 8 },
    { address: orca, symbol: 'ORCA', name: 'Orca', decimals: 6 },
    { address: wsol, symbol: 'SOL', name: 'Solana', decimals: 9 },
    { address: 'invalid!', symbol: 'Invalid', name: 'Invalid', decimals: 7 },
  ]
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ tokens }) })
  const store = renderForm()
  await screen.findByRole('button', { name: 'USDC' })
  expect(global.fetch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Buy token: Select token' }))
  await screen.findByTitle(orca)
  expect(screen.getByTitle(ray).closest('section')?.textContent).toContain('In your wallet')
  expect(screen.getByTitle(ray).textContent).toContain('1.23')
  expect(store.get(walletAssetListAtom).find((token) => token.mint === ray)).toMatchObject({
    decimals: 2,
    symbol: 'RAY',
    icon: undefined,
  })
  expect(screen.queryByText('Duplicate')).toBeNull()
  expect(screen.queryByText('Invalid')).toBeNull()
  expect(screen.getByTitle(wsol).textContent).toContain('wSOL')
  expect(screen.queryByTitle('SOL')).toBeNull()
  const search = screen.getByRole('textbox', { name: 'Search tokens' })
  fireEvent.change(search, { target: { value: 'RaYdIuM' } })
  fireEvent.click(screen.getByTitle(ray))
  expect(await screen.findByRole('button', { name: 'Buy token: RAY' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'ORCA' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Sell token: SOL' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.queryByTitle(ray)).toBeNull()
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: orca } })
  fireEvent.click(dialog.getByTitle(orca))
  expect(await screen.findByRole('button', { name: 'Sell token: ORCA' })).toBeTruthy()
  expect(global.fetch).toHaveBeenCalledTimes(1)
})

it('keeps the presets and manual mint entry usable when the catalog is down', async () => {
  global.fetch = jest.fn().mockRejectedValue(Error('offline'))
  renderForm()
  fireEvent.click(screen.getByRole('button', { name: 'Buy token: Select token' }))
  expect(await screen.findByText(/full token list is unavailable/)).toBeTruthy()
  const dialog = within(screen.getByRole('dialog'))
  for (const symbol of ['JUP', 'BONK', 'JitoSOL']) expect(dialog.getByText(symbol)).toBeTruthy()
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: solanaAddress(pyth) } })
  fireEvent.click(dialog.getByTitle(pyth))
  expect(await screen.findByRole('button', { name: 'Buy token: HZ1Jo…QBCt3' })).toBeTruthy()
})
