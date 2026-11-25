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
jest.mock('./NativeSolanaForm.container', () => ({ NativeSolanaForm: () => null }))
jest.mock('./NativeSolanaOrders.container', () => ({ NativeSolanaOrders: () => null }))
jest.mock('../state/assets.atoms', () => ({
  walletAssetListAtom: jest.requireActual('jotai').atom([
    { mint: 'SOL', symbol: 'SOL' },
    { mint: 'mint', symbol: 'USDC' },
  ]),
}))
jest.mock('../state/orders.atoms', () => ({
  createNativeSolanaOrderAtom: jest
    .requireActual('jotai')
    .atom(null, (_get: unknown, _set: unknown, accepted: boolean) => mockCreate(accepted)),
}))
jest.mock('../state/trade.atoms', () => {
  const { atom } = jest.requireActual('jotai')
  return {
    nativeSolanaBusyAtom: atom(false),
    nativeSolanaErrorAtom: atom(null),
    nativeSolanaReviewAtom: atom({
      form: { sellMint: 'SOL', buyMint: 'mint', slippageBps: 50 },
      sell: { address: 'native', decimals: 9 },
      buy: { address: 'mint', decimals: 6 },
      allowance: { delegate: 'ExistingDelegate', atoms: 1000000n },
      quote: {
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
jest.mock('@cowprotocol/ui', () => ({ ButtonPrimary: 'button' }))

it('shows the signed benchmark and full cost cap in USDC, and requires review of an existing allowance', () => {
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
      <NativeSolanaWidget />
    </I18nProvider>,
  )
  expect(screen.getByText('Quoted output').nextElementSibling?.textContent).toEqual('2 USDC')
  expect(screen.getByText('Minimum received').nextElementSibling?.textContent).toEqual('1.99 USDC')
  expect(screen.getByText('Maximum settlement cost in USDC').nextElementSibling?.textContent).toEqual('0.0003 USDC')
  expect(screen.getByText(/you keep at least half the difference/i)).toBeTruthy()
  const confirm = screen.getByRole('button', { name: 'Confirm in wallet' })
  expect((confirm as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /ExistingDelegate/ }))
  fireEvent.click(confirm)
  expect(mockCreate).toHaveBeenCalledWith(true)
})
