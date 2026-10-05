import { ReactNode } from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SwapPage } from 'pages/Swap'

import mockFixture from './fixtures/monadDeposit.json'
import { NearToken, NearTransfer, nearTransferSchema } from './nearDirect.schemas'
import { getNearFundingDeadline } from './nearDirect.service'
import { NearTransferCard } from './NearTransferCard.container'

let mockEnabled: boolean | undefined = true
let mockStatus: NearTransfer | undefined
let mockTokens: NearToken[] = [mockFixture.source, mockFixture.destination]
const mockSave = jest.fn()

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useSetAtom: () => mockSave,
  useAtomValue: (key: string) => ({ data: key === 'tokens' ? mockTokens : mockStatus }),
}))
jest.mock('./nearDirect.atoms', () => ({ nearTokensAtom: 'tokens', nearTransferStatusAtom: () => 'status' }))
jest.mock('@cowprotocol/common-hooks', () => ({
  useFeatureFlags: () => ({ isNearIntentsBridgeProviderEnabled: mockEnabled }),
  useCopyClipboard: () => [false, jest.fn()],
  useInterval: jest.fn(),
}))
jest.mock('@cowprotocol/ui', () => ({
  UI: jest.requireActual('@cowprotocol/ui').UI,
  InlineBanner: () => null,
  StatusColorVariant: { Info: 'info' },
}))
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: () => ({ chainId: 1 }) }))
jest.mock('@lingui/react', () => ({ useLingui: () => ({ i18n: { _: (value: string) => value } }) }))
jest.mock('entities/cctp', () => ({ useIsCctpEnabled: () => false }))
jest.mock('ophis/hooks/useIsOphisSwap', () => ({ useIsOphisSwap: () => true }))
jest.mock('ophis/mobile/DesktopSwapLayout.pure', () => ({
  DesktopSwapLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
jest.mock('react-router', () => ({
  NavLink: () => null,
  useParams: () => ({ chainId: '1' }),
  useSearchParams: () => [new URLSearchParams('route=near'), jest.fn()],
}))
jest.mock('modules/application', () => ({ NetworkSelector: () => null, PageTitle: () => null }))
jest.mock('modules/nearDirect', () => ({
  ModeButtons: ({ children }: { children: ReactNode }) => <>{children}</>,
  NearDirectSwap: ({ recoveryOnly }: { recoveryOnly?: boolean }) => (
    <p>{recoveryOnly ? 'NEAR recovery' : 'Direct NEAR form'}</p>
  ),
}))
jest.mock('modules/swap', () => ({
  useSwapDerivedStateToFill: jest.fn(),
  SwapUpdaters: () => null,
  SwapWidget: () => <p>Normal swap form</p>,
}))
jest.mock('modules/trade', () => ({}))
jest.mock('common/constants/routes', () => ({ Routes: { SWAP: '/swap' } }))
jest.mock('common/state/HydrateAtom', () => ({
  HydrateAtom: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
jest.mock('./NearQuote.pure', () => ({ NearQuote: () => <p>Saved quote details</p> }))
jest.mock('./NearWalletSend.container', () => ({ NearWalletSend: () => <button>Send with connected wallet</button> }))
jest.mock('react-qrcode-logo', () => ({ QRCode: () => null }))

afterEach(() => {
  jest.restoreAllMocks()
  mockSave.mockReset()
  mockStatus = undefined
  mockTokens = [mockFixture.source, mockFixture.destination]
})

it.each([true, false, undefined])(
  'always renders the existing swap box without provider-branded modes (%s)',
  (enabled) => {
    mockEnabled = enabled
    render(<SwapPage />)
    expect(screen.getByText('Normal swap form')).toBeTruthy()
    expect(screen.queryByText('Direct NEAR form')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cross-chain · NEAR' })).toBeNull()
  },
)

it('retains tracking without any funding instructions while the provider is paused', () => {
  const transfer = nearTransferSchema.parse(mockFixture)
  jest.spyOn(Date, 'now').mockReturnValue(getNearFundingDeadline(transfer.response) - 60_000)
  mockTokens = []
  render(<NearTransferCard transfer={transfer} allowFunding={false} />)
  expect(screen.getByText('Saved quote details')).toBeTruthy()
  expect(screen.getByText(/Swap reference:/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Track transaction' })).toBeTruthy()
  expect(screen.queryByLabelText('Deposit address')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Send with connected wallet' })).toBeNull()
})

it('hides funding immediately when a detected deposit cannot be saved', async () => {
  const transfer = nearTransferSchema.parse(mockFixture)
  jest.spyOn(Date, 'now').mockReturnValue(getNearFundingDeadline(transfer.response) - 60_000)
  mockStatus = { ...transfer, status: 'KNOWN_DEPOSIT_TX', statusUpdatedAt: '2026-09-30T12:00:00.100Z' }
  mockSave.mockRejectedValue(new Error('quota exceeded'))
  render(<NearTransferCard transfer={transfer} />)
  await screen.findByText('quota exceeded')
  expect(screen.getByRole('heading').textContent).toContain('Deposit detected')
  expect(screen.queryByLabelText('Deposit address')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Send with connected wallet' })).toBeNull()
})

it('allows explicit removal of an expired unfunded quote while rechecking current recovery', async () => {
  const transfer = nearTransferSchema.parse(mockFixture)
  jest.spyOn(Date, 'now').mockReturnValue(getNearFundingDeadline(transfer.response) + 2 * 86_400_000)
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false)
  let current = [transfer]
  mockSave.mockImplementation(async (update: (items: NearTransfer[]) => NearTransfer[]) => {
    current = update(current)
  })
  render(<NearTransferCard transfer={transfer} />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove expired quote' }))
  expect(mockSave).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  current = [{ ...transfer, fundingStarted: true }]
  fireEvent.click(screen.getByRole('button', { name: 'Remove expired quote' }))
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
  expect(current).toHaveLength(1)
  current = [transfer]
  fireEvent.click(screen.getByRole('button', { name: 'Remove expired quote' }))
  await waitFor(() => expect(current).toHaveLength(0))
})
