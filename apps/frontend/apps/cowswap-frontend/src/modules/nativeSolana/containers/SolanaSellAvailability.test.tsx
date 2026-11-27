import { fireEvent, screen, waitFor } from '@testing-library/react'

import { fetchOphisWalletHoldings, renderForm, solanaAddress } from './solanaForm.test-utils'

import * as assets from '../services/assets.service'
import * as trade from '../services/trade.service'

it('quotes wallet and pasted mints in both directions without a preexisting solver account', async () => {
  const first = solanaAddress('11111111111111111111111111111112')
  const second = solanaAddress('11111111111111111111111111111113')
  const solver = solanaAddress('11111111111111111111111111111114')
  const native = solanaAddress('11111111111111111111111111111111')
  const { fetchOphisMarketSellMints, fetchOphisWalletSwapCosts } =
    jest.requireMock<typeof import('@ophis/solana-sdk')>('@ophis/solana-sdk')
  jest.replaceProperty(process, 'env', { ...process.env, REACT_APP_OPHIS_SOLANA_MARKET_SOLVER: solver })
  jest.spyOn(assets, 'mainnetWalletRpc').mockReturnValue('https://example.test/wallet-rpc')
  const context = trade.nativeSolanaContext
  jest.spyOn(trade, 'nativeSolanaContext').mockImplementation(async (config) => ({
    ...(await context(config)),
    walletAtomic: true,
  }))
  global.fetch = jest.fn().mockRejectedValue(Error('Catalog offline'))
  const startingHoldings = [
    { mint: native, decimals: 9, atoms: 100_000_000n },
    { mint: first, decimals: 6, atoms: 5_000_000n },
  ]
  jest
    .mocked(fetchOphisWalletHoldings)
    .mockResolvedValueOnce(startingHoldings)
    .mockResolvedValueOnce([...startingHoldings, { mint: second, decimals: 9, atoms: 2_000_000_000n }])
  const quote = jest.spyOn(trade, 'loadNativeSolanaQuote').mockRejectedValue(Error('No executable route'))
  const onReview = jest.fn()
  renderForm(onReview)
  await screen.findByText(/Wallet balance ·/)
  fireEvent.click(screen.getByRole('button', { name: 'Buy token: Select token' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Search tokens' }), { target: { value: second } })
  fireEvent.click(screen.getByTitle(second))
  const max = await screen.findByRole('button', { name: 'Max' })
  await waitFor(() => expect(max.hasAttribute('disabled')).toBe(false))
  fireEvent.click(max)
  const input = screen.getByRole('textbox', { name: 'Amount to sell' }) as HTMLInputElement
  const selected = BigInt(Math.round(Number(input.value) * 1e9))
  const { getOphisNativeSellFeeCap } = jest.requireMock<typeof import('@ophis/solana-sdk')>('@ophis/solana-sdk')
  const budget = (size: bigint): bigint => size + getOphisNativeSellFeeCap(size, second) + 2_646_600n
  expect(budget(selected)).toBeLessThanOrEqual(100_000_000n)
  expect(budget(selected + 1n)).toBeGreaterThan(100_000_000n)
  await waitFor(() =>
    expect(fetchOphisWalletSwapCosts).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      second,
      true,
      2,
      { solver, sellMint: 'So11111111111111111111111111111111111111112' },
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Sell token: SOL' }))
  fireEvent.click(await screen.findByTitle(first))
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount to sell' }), { target: { value: '1.25' } })
  await waitFor(() =>
    expect(quote).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        sellMint: first,
        buyMint: second,
        amount: '1.25',
      }),
      expect.anything(),
    ),
  )
  expect((await screen.findByRole('alert')).textContent).toBe('No executable route')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh balance' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reverse tokens' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Amount to sell' }), { target: { value: '0.5' } })
  await waitFor(() =>
    expect(quote).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        sellMint: second,
        buyMint: first,
        amount: '0.5',
      }),
      expect.anything(),
    ),
  )
  expect(fetchOphisWalletSwapCosts).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.anything(),
    first,
    false,
    2,
    { solver, sellMint: second },
  )
  expect(fetchOphisMarketSellMints).not.toHaveBeenCalled()
  expect(onReview).not.toHaveBeenCalled()
})

it('lets Max reuse native-wrap rent that returns before the native Ophis fee', async () => {
  const { fetchOphisWalletSwapCosts } = jest.requireMock<typeof import('@ophis/solana-sdk')>('@ophis/solana-sdk')
  const fixed = 4_140_040n
  jest.mocked(fetchOphisWalletSwapCosts).mockResolvedValueOnce({
    reserve: fixed,
    nativeWrapRent: 1_488_440n,
    solverInputRent: 0n,
  } as Awaited<ReturnType<typeof fetchOphisWalletSwapCosts>>)
  const context = trade.nativeSolanaContext
  jest.spyOn(trade, 'nativeSolanaContext').mockImplementation(async (config) => ({
    ...(await context(config)),
    walletAtomic: true,
  }))
  jest
    .mocked(fetchOphisWalletHoldings)
    .mockResolvedValueOnce([
      { mint: solanaAddress('11111111111111111111111111111111'), atoms: 6_520_288n, decimals: 9 },
    ])
  renderForm()
  fireEvent.click(await screen.findByRole('button', { name: 'USDC' }))
  const max = screen.getByRole('button', { name: 'Max' })
  await waitFor(() => expect(max.hasAttribute('disabled')).toBe(false))
  fireEvent.click(max)
  expect((screen.getByRole('textbox', { name: 'Amount to sell' }) as HTMLInputElement).value).toBe('0.002380248')
})
