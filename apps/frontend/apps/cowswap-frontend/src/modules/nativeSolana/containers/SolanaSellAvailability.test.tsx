import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { queryClientAtom } from 'jotai-tanstack-query'

import { renderForm, solanaAddress, solanaConnectionAtom } from './solanaForm.test-utils'

import * as assets from '../services/assets.service'
import * as trade from '../services/trade.service'
import { marketSellMintsKey } from '../state/assets.atoms'
import { nativeSolanaFormAtom } from '../state/trade.atoms'

const ray = solanaAddress('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R')
const jup = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const { fetchOphisMarketSellMints, WRAPPED_SOL_MINT } =
  jest.requireMock<typeof import('@ophis/solana-sdk')>('@ophis/solana-sdk')
const inventory = jest.mocked(fetchOphisMarketSellMints)

beforeEach(() => {
  inventory.mockReset()
  jest.replaceProperty(process, 'env', { ...process.env, REACT_APP_OPHIS_SOLANA_MARKET_SOLVER: ray })
  jest.spyOn(assets, 'mainnetWalletRpc').mockReturnValue('https://example.test/wallet-rpc')
  const context = trade.nativeSolanaContext
  jest.spyOn(trade, 'nativeSolanaContext').mockImplementation(async (config) => ({
    ...(await context(config)),
    walletAtomic: true,
  }))
})

it('explains an unavailable sell mint on selection before an amount or wallet is needed', async () => {
  inventory.mockResolvedValue([WRAPPED_SOL_MINT])
  global.fetch = jest.fn().mockRejectedValue(Error('catalog offline'))
  const store = renderForm()
  await act(async () => store.set(solanaConnectionAtom, null))
  fireEvent.click(screen.getByRole('button', { name: 'Sell token: SOL' }))
  fireEvent.click(await screen.findByTitle(jup))
  expect(await screen.findByText(/currently unavailable to sell/)).toBeTruthy()
  expect((screen.getByRole('textbox', { name: 'Amount to sell' }) as HTMLInputElement).value).toBe('')
  await act(async () => store.set(nativeSolanaFormAtom, { sellMint: 'SOL', buyMint: jup, amount: '', slippageBps: 50 }))
  expect(screen.queryByText(/currently unavailable to sell/)).toBeNull()
  expect(inventory).toHaveBeenCalledTimes(1)
})

it('waits for the sell account before quoting and resumes when a retry finds it', async () => {
  inventory.mockResolvedValueOnce([WRAPPED_SOL_MINT]).mockResolvedValueOnce([WRAPPED_SOL_MINT, ray])
  const quote = jest.spyOn(trade, 'loadNativeSolanaQuote').mockRejectedValue(Error('Route check'))
  const store = renderForm()
  await act(async () =>
    store.set(nativeSolanaFormAtom, { sellMint: ray, buyMint: 'SOL', amount: '1', slippageBps: 50 }),
  )
  expect(await screen.findByText(/currently unavailable to sell/)).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Swap' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(quote).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  await waitFor(() => expect(quote).toHaveBeenCalledTimes(1))
  expect(screen.queryByText(/currently unavailable to sell/)).toBeNull()
})

it('leaves the normal quote available when the account check fails', async () => {
  inventory.mockRejectedValue(Error('RPC unavailable'))
  const quote = jest.spyOn(trade, 'loadNativeSolanaQuote').mockRejectedValue(Error('Route check'))
  const store = renderForm()
  await act(async () =>
    store.set(nativeSolanaFormAtom, { sellMint: ray, buyMint: 'SOL', amount: '1', slippageBps: 50 }),
  )
  expect(await screen.findByText(/could not be checked/)).toBeTruthy()
  await waitFor(() => expect(quote).toHaveBeenCalledTimes(1))
  expect(screen.queryByText(/currently unavailable to sell/)).toBeNull()
})

it('refreshes an old inventory when the sell mint changes', async () => {
  inventory.mockResolvedValueOnce([WRAPPED_SOL_MINT]).mockResolvedValueOnce([WRAPPED_SOL_MINT, ray])
  const store = renderForm()
  const client = store.get(queryClientAtom)
  const key = [...marketSellMintsKey, 'https://example.test', 'mainnet', ray]
  await waitFor(() => expect(client.getQueryState(key)?.status).toBe('success'))
  await act(async () => {
    client.setQueryData(key, client.getQueryData(key), { updatedAt: Date.now() - 60_000 })
    store.set(nativeSolanaFormAtom, { sellMint: ray, buyMint: '', amount: '', slippageBps: 50 })
  })
  await waitFor(() => expect(inventory).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByText(/currently unavailable to sell/)).toBeNull())
})
