import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'

import { NativeSolanaHistory } from './NativeSolanaHistory.container'

const mockSignature = '1'.repeat(64)
jest.mock(
  '@ophis/solana-sdk',
  () => ({
    fetchOphisSolanaTrades: async () => [
      {
        txSignature: mockSignature,
        instructionIndex: 0,
        orderUid: 'order',
        buyAmount: '100',
        buyToken: 'mint',
        feeMint: 'mint',
        protocolFee: '1',
      },
    ],
    solanaAddress: (address: string) => address,
  }),
  { virtual: true },
)
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { api: 'https://example.invalid', chain: 'solana:mainnet', genesis: 'mainnet' },
  solanaConnectionAtom: jest.requireActual('jotai').atom({ account: { address: 'owner' } }),
}))
jest.mock('../services/assets.service', () => ({ walletMint: (mint: string) => mint }))
jest.mock('../state/assets.atoms', () => ({ walletAssetListAtom: jest.requireActual('jotai').atom([]) }))

it('opens the settlement transaction from the mainnet wallet history', async () => {
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
      <NativeSolanaHistory />
    </I18nProvider>,
  )
  expect((await screen.findByRole('link', { name: 'View settlement on Solana Explorer' })).getAttribute('href')).toBe(
    'https://explorer.solana.com/tx/' + mockSignature,
  )
})
