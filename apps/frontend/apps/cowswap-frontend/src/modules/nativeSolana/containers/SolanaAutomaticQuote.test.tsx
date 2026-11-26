import { act, fireEvent, screen, waitFor } from '@testing-library/react'

import { renderForm } from './solanaForm.test-utils'

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
