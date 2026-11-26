import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'

import { NativeSolanaHistory } from './NativeSolanaHistory.container'

import { SolanaReceipt } from '../pure/SolanaReceipt.pure'

import type { SavedNativeSolanaOrder } from '../state/orders.atoms'
import type { OphisSolanaOrder } from '@ophis/solana-sdk'

const mockSignature = '1'.repeat(64)
jest.mock(
  '@ophis/solana-sdk',
  () => ({
    fetchOphisSolanaTrades: async () => [
      {
        txSignature: mockSignature,
        instructionIndex: 0,
        slot: 474204967,
        orderUid: 'order',
        owner: 'owner',
        sellAmount: '120',
        sellToken: 'soldMint',
        buyAmount: '100',
        buyToken: 'mint',
        feeMint: 'mint',
        protocolFee: '1',
      },
    ],
    fetchOphisSolanaOrder: async () => ({
      uid: 'order',
      creationDate: '2026-11-26T15:51:31Z',
      owner: 'owner',
      sellToken: 'soldMint',
      buyToken: 'mint',
      sellAmount: '120',
      buyAmount: '90',
      executedBuyAmount: '100',
      status: 'fulfilled',
    }),
    solanaAddress: (address: string) => address,
  }),
  { virtual: true },
)
jest.mock('@cowprotocol/common-utils', () => ({
  ...jest.requireActual('@cowprotocol/common-utils'),
  fetchWithTimeout: jest.fn(async () => ({ ok: true, json: async () => ({ result: 1795708320 }) })),
}))
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { api: 'https://example.invalid', chain: 'solana:mainnet', genesis: 'mainnet' },
  solanaConnectionAtom: jest.requireActual('jotai').atom({ wallet: { name: 'Wallet' }, account: { address: 'owner' } }),
}))
jest.mock('../services/assets.service', () => ({
  walletMint: (mint: string) => mint,
  unknownAsset: (mint: string) => ({ mint, symbol: mint }),
  solanaAssetIdentity: () => ({}),
}))
jest.mock('entities/verifiedAsset', () => ({
  useAssetVerificationResolver: () => () => undefined,
  VerifiedAssetBadge: () => null,
}))
jest.mock('../state/assets.atoms', () => {
  const { atom } = jest.requireActual('jotai')
  return { walletAssetListAtom: atom([]), solanaMainnetCatalogAtom: atom({}), solanaCachedCatalogAtom: atom({}) }
})

it('opens the settlement transaction from the mainnet wallet history', async () => {
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
      <NativeSolanaHistory />
    </I18nProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: /View receipt/ }))
  const received = screen.getByText('You received').closest('section')
  expect(received?.textContent).toContain('100')
  expect(await screen.findByText('29 s')).toBeTruthy()
  fireEvent.click(screen.getByText('Details'))
  expect((await screen.findByText('Minimum received')).nextElementSibling?.textContent).toContain('90')
  expect(screen.getByText('Ophis fee').nextElementSibling?.textContent).toContain('1 base units')
  expect((await screen.findByRole('link', { name: 'View settlement on Solana Explorer' })).getAttribute('href')).toBe(
    'https://explorer.solana.com/tx/' + mockSignature,
  )
})

it('keeps the signed minimum distinct from a fill while indexing and links only known transactions', () => {
  const order = { uid: 'order', signature: mockSignature, intent: [] } as unknown as SavedNativeSolanaOrder
  const data = {
    status: 'open',
    sellToken: 'soldMint',
    buyToken: 'mint',
    sellAmount: '120',
    buyAmount: '90',
    executedBuyAmount: '0',
    executedSellAmount: '0',
  } as OphisSolanaOrder
  const receipt = (
    status: 'open' | 'unconfirmed' | 'fulfilled',
    signature: string | null,
  ): import('react').ReactElement => (
    <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
      <SolanaReceipt
        verifyAsset={() => undefined}
        saved={{ ...order, signature }}
        data={status === 'unconfirmed' ? undefined : data}
        status={status}
        assets={[]}
        onBack={jest.fn()}
      />
    </I18nProvider>
  )
  const { rerender } = render(receipt('open', mockSignature))
  expect(screen.getByText('Minimum to receive').closest('section')?.textContent).toContain('90')
  expect(screen.queryByText('You received')).toBeNull()
  expect(screen.getByRole('link', { name: /View order transaction/ }).getAttribute('href')).toBe(
    'https://explorer.solana.com/tx/' + mockSignature,
  )
  rerender(receipt('fulfilled', mockSignature))
  expect(screen.queryByRole('link', { name: /View settlement/ })).toBeNull()
  expect(screen.queryByText('You received')).toBeNull()
  rerender(receipt('unconfirmed', null))
  expect(screen.getByRole('status').textContent?.trim()).toBe('Unconfirmed')
  expect(screen.queryByRole('link')).toBeNull()
})
