import { createStore, Provider } from 'jotai'
import type { ReactNode } from 'react'

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fetchOphisNativeSellReserve, solanaAddress } from '@ophis/solana-sdk'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { solanaConnectionAtom } from 'entities/solana'
import { queryClientAtom } from 'jotai-tanstack-query'

import { NativeSolanaForm } from './NativeSolanaForm.container'

import { walletAssetListAtom } from '../state/assets.atoms'
import { nativeSolanaFormAtom } from '../state/trade.atoms'

const ray = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'
const orca = 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'
const aapl = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp'
const nvda = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'
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
    fetchOphisNativeSellReserve: jest.fn().mockResolvedValue(2646600n),
    fetchOphisWalletHoldings: async () => [
      { mint: '11111111111111111111111111111111', atoms: 2822552n, decimals: 9 },
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
    { address: aapl, symbol: 'XsbEh…LJzJp', name: 'Conflicting symbol from catalog', decimals: 8 },
    { address: nvda, symbol: 'NVDAx', name: 'NVIDIA xStock', decimals: 8 },
    { address: wsol, symbol: 'SOL', name: 'Solana', decimals: 9 },
    { address: 'invalid!', symbol: 'Invalid', name: 'Invalid', decimals: 7 },
  ]
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ tokens }) })
  const store = renderForm()
  await screen.findByRole('button', { name: 'USDC' })
  expect(global.fetch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Buy token: Select token' }))
  await screen.findByTitle(orca)
  expect(
    within(screen.getByRole('button', { name: 'Sell token: SOL' })).getByRole('img', { name: /Native currency/ }),
  ).toBeTruthy()
  const stock = screen.getByTitle(nvda)
  expect(await within(stock).findByText('xStocks')).toBeTruthy()
  expect(within(screen.getByTitle(aapl)).queryByText('xStocks')).toBeNull()
  expect(within(screen.getByTitle(ray)).queryByText('xStocks')).toBeNull()
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
  fireEvent.click(stock)
  const selectedStock = await screen.findByRole('button', { name: 'Buy token: NVDAx' })
  expect(within(selectedStock).getByText('xStocks')).toBeTruthy()
  fireEvent.click(selectedStock)
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
  expect(within(dialog.getByTitle(pyth)).queryByText('xStocks')).toBeNull()
  fireEvent.click(dialog.getByTitle(pyth))
  const selected = await screen.findByRole('button', { name: 'Buy token: HZ1Jo…QBCt3' })
  fireEvent.click(selected)
  const picker = within(screen.getByRole('dialog'))
  fireEvent.change(picker.getByRole('textbox'), { target: { value: nvda } })
  const stock = picker.getByTitle(nvda)
  expect(await within(stock).findByText('xStocks')).toBeTruthy()
  fireEvent.click(stock)
  const selectedStock = await screen.findByRole('button', { name: 'Buy token: Xsc9q…x9qEh' })
  expect(within(selectedStock).getByText('xStocks')).toBeTruthy()
})

it('applies whole-atom presets, reserves live SOL costs and disables them when the wallet disconnects', async () => {
  const store = renderForm()
  const max = screen.getByRole('button', { name: 'Max' })
  const quarter = screen.getByRole('button', { name: '25%' })
  expect(max.hasAttribute('disabled')).toBe(true)
  fireEvent.click(await screen.findByRole('button', { name: 'USDC' }))
  await waitFor(() => expect(max.hasAttribute('disabled')).toBe(false))
  fireEvent.click(max)
  expect(store.get(nativeSolanaFormAtom).amount).toBe('0.000175952')
  fireEvent.click(quarter)
  expect(store.get(nativeSolanaFormAtom).amount).toBe('0.000043988')
  act(() => store.set(nativeSolanaFormAtom, (form) => ({ ...form, sellMint: ray, amount: '' })))
  fireEvent.click(quarter)
  expect(store.get(nativeSolanaFormAtom).amount).toBe('0.3')
  fireEvent.click(screen.getByRole('button', { name: '50%' }))
  expect(store.get(nativeSolanaFormAtom).amount).toBe('0.61')
  fireEvent.click(max)
  expect(store.get(nativeSolanaFormAtom).amount).toBe('1.23')
  await act(async () => store.set(solanaConnectionAtom, null))
  expect(max.hasAttribute('disabled')).toBe(true)
})

it('retries a failed SOL reserve estimate on Refresh balance and keeps manual entry available', async () => {
  const reserve = jest.mocked(fetchOphisNativeSellReserve)
  let recover: (lamports: bigint) => void = () => undefined
  reserve
    .mockClear()
    .mockRejectedValueOnce(Error('RPC unavailable'))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          recover = resolve
        }),
    )
  const store = renderForm()
  const max = screen.getByRole('button', { name: 'Max' })
  const refresh = screen.getByRole('button', { name: 'Refresh balance' })
  fireEvent.click(await screen.findByRole('button', { name: 'USDC' }))
  await waitFor(() => {
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(refresh.hasAttribute('disabled')).toBe(false)
  })
  expect(max.hasAttribute('disabled')).toBe(true)
  fireEvent.click(refresh)
  await waitFor(() => expect(reserve).toHaveBeenCalledTimes(2))
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount to sell' }), { target: { value: '0.0001' } })
  expect(store.get(nativeSolanaFormAtom).amount).toBe('0.0001')
  await act(async () => {
    recover(2646600n)
  })
  await waitFor(() => expect(max.hasAttribute('disabled')).toBe(false))
  fireEvent.click(max)
  expect(store.get(nativeSolanaFormAtom).amount).toBe('0.000175952')
})
