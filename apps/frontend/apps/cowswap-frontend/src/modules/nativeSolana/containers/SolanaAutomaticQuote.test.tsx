import { act, fireEvent, screen, waitFor } from '@testing-library/react'

import { fetchOphisWalletHoldings, renderForm, solanaAddress } from './solanaForm.test-utils'

import * as trade from '../services/trade.service'
import { nativeSolanaFormAtom } from '../state/trade.atoms'

const ray = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'

it('automatically prices the latest input, ignores a superseded response and reviews only on Swap', async () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const finish: (() => void)[] = []
  const load = jest.spyOn(trade, 'loadNativeSolanaQuote').mockImplementation(
    (_config, connection, form) =>
      new Promise((resolve) => {
        finish.push(() =>
          resolve({
            connection,
            form,
            buy: { decimals: 6 },
            quote: {
              expiration: new Date(Date.now() + 60_000).toISOString(),
              quote: { buyAmount: form.amount === '1' ? '1000000' : '250000' },
            },
          } as trade.NativeSolanaReview),
        )
      }),
  )
  const onReview = jest.fn()
  const store = renderForm(onReview)
  await screen.findByText(/Wallet balance ·/)
  await act(async () => store.set(nativeSolanaFormAtom, { sellMint: ray, buyMint: usdc, amount: '1', slippageBps: 50 }))
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  const input = screen.getByRole('textbox', { name: 'Amount to sell' })
  fireEvent.change(input, { target: { value: '0.2' } })
  fireEvent.change(input, { target: { value: '0.25' } })
  expect(screen.getByRole('button', { name: 'Getting quote…' }).hasAttribute('disabled')).toBe(true)
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  await act(async () => finish[1]())
  await act(async () => finish[0]())
  expect(screen.getByText('0.25')).toBeTruthy()
  expect(screen.getByText(/Minimum received/).textContent).toContain('0.24875 USDC')
  expect(onReview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
  expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ form: expect.objectContaining({ amount: '0.25' }) }))
  load.mockRejectedValueOnce(Error('No route'))
  fireEvent.change(input, { target: { value: '0.3' } })
  expect(screen.queryByText('0.25')).toBeNull()
  expect((await screen.findByRole('alert')).textContent).toBe('No route')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' }))
  await waitFor(() => expect(load).toHaveBeenCalledTimes(4))
  expect(onReview).toHaveBeenCalledTimes(1)
})

it('shows a retry for an expired quote and clears the message on edit', async () => {
  jest.spyOn(trade, 'loadNativeSolanaQuote').mockImplementation(
    async (_config, connection, form) =>
      ({
        connection,
        form,
        quote: { expiration: new Date(0).toISOString() },
      }) as trade.NativeSolanaReview,
  )
  const store = renderForm()
  await screen.findByText(/Wallet balance ·/)
  await act(async () =>
    store.set(nativeSolanaFormAtom, { sellMint: ray, buyMint: 'SOL', amount: '1', slippageBps: 50 }),
  )
  expect((await screen.findByRole('alert')).textContent).toMatch(/expired/)
  expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount to sell' }), { target: { value: '' } })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows the SOL shortfall on an SPL sale and quotes after a balance refresh covers it', async () => {
  const usdc = solanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
  const sol = solanaAddress('11111111111111111111111111111111')
  const holdings = (atoms: bigint): Awaited<ReturnType<typeof fetchOphisWalletHoldings>> => [
    { mint: sol, decimals: 9, atoms },
    { mint: usdc, decimals: 6, atoms: 273239n },
  ]
  jest
    .mocked(fetchOphisWalletHoldings)
    .mockResolvedValueOnce(holdings(826192n))
    .mockResolvedValueOnce(holdings(2812552n))
  const load = jest.spyOn(trade, 'loadNativeSolanaQuote').mockRejectedValue(Error('Quote service reached'))
  const store = renderForm()
  await act(async () =>
    store.set(nativeSolanaFormAtom, { sellMint: usdc, buyMint: 'SOL', amount: '0.273239', slippageBps: 50 }),
  )
  expect((await screen.findByRole('alert')).textContent).toContain('0.001820408 more SOL')
  expect(screen.getByRole('button', { name: 'Swap' }).hasAttribute('disabled')).toBe(true)
  expect(load).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh balance' }))
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  expect(screen.queryByText(/more SOL/)).toBeNull()
})

it.each([
  ['SOL', true],
  ['So11111111111111111111111111111111111111112', false],
  ['11111111111111111111111111111112', false],
])('accounts for the signed Ophis fee ceiling when receiving %s', async (buyMint, paysFromProceeds) => {
  const native = solanaAddress('11111111111111111111111111111111')
  const sell = solanaAddress(ray)
  const fixed = 2_646_600n
  jest.mocked(fetchOphisWalletHoldings).mockResolvedValueOnce([
    { mint: native, decimals: 9, atoms: fixed },
    { mint: sell, decimals: 2, atoms: 100n },
  ])
  jest.spyOn(trade, 'loadNativeSolanaQuote').mockImplementation(
    async (_config, connection, form) =>
      ({
        connection,
        form,
        buy: { decimals: 9 },
        quote: {
          expiration: new Date(Date.now() + 60_000).toISOString(),
          quote: {
            buyAmount: '10000000',
            nativeProtocolFee: {
              estimatedLamports: '1000',
              maxLamports: '10000',
              rateLamports: '10000000',
              rateBuyAtoms: '10000000',
            },
          },
        },
      }) as trade.NativeSolanaReview,
  )
  const store = renderForm()
  await act(async () => store.set(nativeSolanaFormAtom, { sellMint: sell, buyMint, amount: '1', slippageBps: 50 }))
  await screen.findByText(/Minimum received/)
  expect(screen.getByRole('button', { name: 'Swap' }).hasAttribute('disabled')).toBe(!paysFromProceeds)
  if (!paysFromProceeds) expect(screen.getByRole('alert').textContent).toContain('0.00001 more SOL')
})
