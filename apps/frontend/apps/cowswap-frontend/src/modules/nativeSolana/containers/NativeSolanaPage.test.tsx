import { createStore, Provider } from 'jotai'

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'

import { NativeSolanaWidget } from './NativeSolanaPage.container'

const mockCreate = jest.fn()
jest.mock(
  '@ophis/solana-sdk',
  () => ({
    formatOphisSolanaAmount: (atoms: bigint, decimals: number) => (Number(atoms) / 10 ** decimals).toString(),
  }),
  { virtual: true },
)
jest.mock('entities/solana', () => ({ solanaConnectionAtom: jest.requireActual('jotai').atom(null) }))
jest.mock('./NativeSolanaForm.container', () => ({
  NativeSolanaForm: ({ onReview }: { onReview(review: unknown): void }) => {
    const { useAtomValue } = jest.requireActual('jotai')
    const review = useAtomValue(jest.requireMock('../state/trade.atoms').nativeSolanaReviewAtom)
    return <button onClick={() => onReview(review)}>Swap</button>
  },
}))
jest.mock('./NativeSolanaOrders.container', () => ({
  NativeSolanaOrders: ({ children }: { children: import('react').ReactNode }) => children,
}))
jest.mock('../state/assets.atoms', () => ({
  walletAssetListAtom: jest.requireActual('jotai').atom([
    { mint: 'SOL', symbol: 'SOL' },
    { mint: 'mint', symbol: 'USDC' },
  ]),
}))
jest.mock('../state/placeOrder.atoms', () => ({
  createNativeSolanaOrderAtom: jest
    .requireActual('jotai')
    .atom(null, (_get: unknown, _set: unknown, accepted: boolean) => mockCreate(accepted)),
}))
jest.mock('../state/trade.atoms', () => {
  const { atom } = jest.requireActual('jotai')
  return {
    clearNativeSolanaReviewAtom: atom(null, () => undefined),
    nativeSolanaBusyAtom: atom(false),
    nativeSolanaErrorAtom: atom(null),
    nativeSolanaReviewAtom: atom({
      form: { sellMint: 'SOL', buyMint: 'mint', slippageBps: 50 },
      sell: { address: 'native', decimals: 9 },
      buy: { address: 'mint', decimals: 6 },
      allowance: { delegate: 'ExistingDelegate', atoms: 1000000n },
      quote: {
        expiration: new Date(Date.now() + 60_000).toISOString(),
        quote: {
          sellAmount: '20000000',
          feeAmount: '0',
          buyAmount: '2000000',
          feeTerms: { baseBps: 1, improvementShareBps: 5000, improvementCapBps: 99 },
          costs: { networkFees: '240', buyTokenAtaCosts: '60', protocolFee: '200', total: '500' },
        },
      },
    }),
  }
})
jest.mock('../services/privateSettlement.service', () => ({ privateSettlementEnabled: false }))
jest.mock('common/constants/routes', () => ({ SOLANA_SWAP_URL: '/swap?network=solana' }))
jest.mock('ophis/ds', () => ({}))
jest.mock('@cowprotocol/ui', () => ({
  ButtonPrimary: 'button',
  UI: {},
  Media: { upToSmall: () => '@media (max-width: 600px)' },
}))
jest.mock('entities/verifiedAsset', () => ({ useAssetVerification: () => undefined, VerifiedAssetBadge: () => null }))

it('shows the signed benchmark and full cost cap in USDC, and requires review of an existing allowance', () => {
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
      <NativeSolanaWidget />
    </I18nProvider>,
  )
  expect(screen.queryByText('Review your swap')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
  expect(screen.getByText('USDC', { exact: true }).closest('[title]')?.textContent).toBe('2 USDC')
  expect(screen.getByText('Minimum received').nextElementSibling?.textContent).toEqual('1.99 USDC')
  expect(screen.getByText('Maximum settlement cost in USDC').nextElementSibling?.textContent).toEqual('0.0003 USDC')
  const details = screen.getByText('Fee details').closest('details')
  expect(details?.open).toBe(false)
  fireEvent.click(screen.getByText('Fee details'))
  expect(details?.open).toBe(true)
  expect(screen.getByText('50%, capped at 0.99% of the trade')).toBeTruthy()
  const confirm = screen.getByRole('button', { name: 'Confirm in wallet' })
  expect((confirm as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /ExistingDelegate/ }))
  fireEvent.click(confirm)
  expect(mockCreate).toHaveBeenCalledWith(true)
})

it('distinguishes the paid network fee, returned order and wrap deposits, and a new receiving token account', () => {
  const store = createStore()
  const { nativeSolanaReviewAtom } = jest.requireMock('../state/trade.atoms')
  const prior = store.get(nativeSolanaReviewAtom) as import('../services/trade.service').NativeSolanaReview
  store.set(nativeSolanaReviewAtom, {
    ...prior,
    allowance: null,
    quote: {
      ...prior.quote,
      quote: {
        ...prior.quote.quote,
        costs: { networkFees: '0', buyTokenAtaCosts: '0', protocolFee: '0', total: '0' },
        nativeProtocolFee: {
          estimatedLamports: '5000',
          maxLamports: '45000',
          rateLamports: '5000000',
          rateBuyAtoms: '2000000',
        },
      },
    },
    atomic: {
      costs: {
        networkFee: 10_000n,
        orderRent: 1_991_360n,
        nativeWrapRent: 1_488_440n,
        solverInputRent: 1_488_440n,
        tokenAccountRent: 1_488_440n,
      },
    },
  })
  render(
    <Provider store={store}>
      <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
        <NativeSolanaWidget />
      </I18nProvider>
    </Provider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
  expect(screen.getByText('Solana network fee').nextElementSibling?.textContent).toBe('0.00001 SOL')
  const details = screen.getByText('Fee details').closest('details')
  expect(details?.open).toBe(false)
  expect(details?.contains(screen.getByText('New wallet token account deposit'))).toBe(true)
  expect(details?.contains(screen.getByText('Deposit returned in this swap'))).toBe(true)
  expect(screen.getByText('Estimated Ophis fee').nextElementSibling?.textContent).toBe('0.000005 SOL')
  expect(screen.getByText('Maximum Ophis fee').nextElementSibling?.textContent).toBe('0.000045 SOL')
  expect(screen.queryByText('Ophis base fee')).toBeNull()
  expect(screen.queryByText('Estimated SOL after the Ophis fee')).toBeNull()
  expect(screen.getByText('Minimum received').nextElementSibling?.textContent).toBe('1.99 USDC')
  expect(screen.getByText('Deposit returned in this swap').nextElementSibling?.textContent).toBe('0.00496824 SOL')
  expect(screen.getByText('New wallet token account deposit').nextElementSibling?.textContent).toBe('0.00148844 SOL')
  expect(screen.queryByText(/maximum settlement cost/i)).toBeNull()
  expect((screen.getByRole('button', { name: 'Confirm in wallet' }) as HTMLButtonElement).disabled).toBe(false)
})

it('shows the gross SOL payout and the wallet proceeds after the separate native fee', () => {
  const store = createStore()
  const { nativeSolanaReviewAtom } = jest.requireMock('../state/trade.atoms')
  const review = store.get(nativeSolanaReviewAtom) as import('../services/trade.service').NativeSolanaReview
  store.set(nativeSolanaReviewAtom, {
    ...review,
    allowance: null,
    form: { ...review.form, sellMint: 'mint', buyMint: 'SOL' },
    buy: { ...review.buy, decimals: 9 },
    atomic: { costs: { networkFee: 10_000n, orderRent: 0n, tokenAccountRent: 0n } },
    quote: {
      ...review.quote,
      quote: {
        ...review.quote.quote,
        buyAmount: '100000000',
        nativeProtocolFee: {
          estimatedLamports: '10000',
          maxLamports: '1009900',
          rateLamports: '100000000',
          rateBuyAtoms: '100000000',
        },
      },
    },
  })
  render(
    <Provider store={store}>
      <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
        <NativeSolanaWidget />
      </I18nProvider>
    </Provider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Swap' }))
  expect(screen.getByText('SOL', { exact: true }).closest('[title]')?.textContent).toBe('0.1 SOL')
  expect(screen.getByText('Minimum received').nextElementSibling?.textContent).toBe('0.0995 SOL')
  expect(screen.getByText('Estimated SOL after the Ophis fee').nextElementSibling?.textContent).toBe('0.09999 SOL')
  expect(screen.getByText('Solana network fee').nextElementSibling?.textContent).toBe('0.00001 SOL')
})
