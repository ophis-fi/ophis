import { createStore, Provider } from 'jotai'

import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { solanaConnectionAtom, type SolanaConnection } from 'entities/solana'
import { MemoryRouter } from 'react-router'
import { ThemeProvider } from 'styled-components/macro'
import { getCowswapTheme } from 'theme'

import { AccountElement } from 'legacy/components/Header/AccountElement'

import { OrdersPanel } from 'modules/account'

import { NativeSolanaOrders } from './NativeSolanaOrders.container'

import { savedNativeSolanaOrdersAtom } from '../state/orders.atoms'

const mockFetchTrades = jest.fn()
const mockEvm = '0x00000000000000000000000000000000000000f1'
let mockEvmConnected = false

jest.mock(
  '@ophis/solana-sdk',
  () => ({
    fetchOphisSolanaTrades: (...args: unknown[]) => mockFetchTrades(...args),
    solanaAddress: (address: string) => address,
  }),
  { virtual: true },
)
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { api: 'https://example.invalid', chain: 'solana:mainnet', genesis: 'mainnet' },
  solanaConnectionAtom: jest.requireActual('jotai').atom(null),
}))
jest.mock('@cowprotocol/assets/images/x.svg?react', () => () => null)
jest.mock('@cowprotocol/common-hooks', () => ({
  ...jest.requireActual('@cowprotocol/common-hooks'),
  useBodyScrollbarLocker: () => undefined,
}))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: mockEvmConnected ? mockEvm : undefined, active: mockEvmConnected, chainId: 1 }),
  useWalletDetails: () => ({ walletName: 'EVM wallet' }),
  useConnectionType: () => 'INJECTED',
  useDisconnectWallet: () => jest.fn(),
  useIsWalletConnect: () => false,
  getIsInjectedMobileBrowser: () => false,
  getIsHardWareWallet: () => false,
  ConnectionType: { GNOSIS_SAFE: 'GNOSIS_SAFE' },
}))
jest.mock('modules/notifications', () => ({
  useUnreadSidebarNotificationsCount: () => 0,
  useHasNotificationSubscription: () => ({}),
  useNotificationAlertDismissal: () => ({}),
  NotificationSidebar: () => null,
  NotificationBell: () => null,
}))
jest.mock('legacy/components/Header/AccountElement/NotificationAlertPopover', () => ({
  NotificationAlertPopover: () => null,
}))
jest.mock('modules/wallet', () => ({
  Web3Status: ({ onClick }: { onClick: () => void }) =>
    mockEvmConnected ? <button onClick={onClick}>{mockEvm}</button> : null,
}))
jest.mock('modules/wallet/containers/AccountSelectorModal/state', () => ({
  toggleAccountSelectorModalAtom: jest.requireActual('jotai').atom(null),
}))
jest.mock('modules/account', () => ({
  ...jest.requireActual('modules/account/hooks/useToggleAccountModal'),
  ...jest.requireActual('modules/account/containers/OrdersPanel'),
}))
jest.mock('modules/nativeSolana', () => jest.requireActual('./NativeSolanaHistory.container'))
jest.mock('legacy/state/hooks', () => ({ useAppDispatch: () => jest.fn() }))
jest.mock('legacy/state/user/reducer', () => ({ updateSelectedWallet: jest.fn() }))
jest.mock('legacy/components/Copy', () => () => null)
jest.mock('modules/injectedWidget', () => ({ useInjectedWidgetParams: () => ({}) }))
jest.mock('common/hooks/useIsProviderNetworkUnsupported', () => ({ useIsProviderNetworkUnsupported: () => false }))
jest.mock('common/hooks/useCategorizeRecentActivity', () => ({
  useCategorizeRecentActivity: () => ({
    pendingActivity: [],
    confirmedActivity: mockEvmConnected ? ['evm-order'] : [],
  }),
}))
jest.mock('legacy/hooks/useRecentActivity', () => ({
  useMultipleActivityDescriptors: ({ ids }: { ids: string[] }) => ids,
  groupActivitiesByDay: (activities: string[]) => [{ date: new Date(0), activities }],
}))
jest.mock('modules/account/containers/AccountDetails/ActivitiesList', () => ({
  ActivitiesList: ({ activities }: { activities: string[] }) => <div>{activities.join()}</div>,
}))
jest.mock('modules/account/containers/AccountDetails/AccountIcon', () => ({ AccountIcon: () => null }))
jest.mock('modules/account/containers/AccountDetails/SurplusCard', () => ({ SurplusCard: () => null }))
jest.mock('modules/account/containers/CowShedInfo', () => ({ CowShedInfo: () => null }))
jest.mock('../services/assets.service', () => ({
  shortMint: (mint: string) => mint,
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
jest.mock('../services/privateSettlement.service', () => ({ privateSettlementEnabled: false }))
jest.mock('../state/orderActions.atoms', () => ({}))
jest.mock('../state/trade.atoms', () => ({}))
jest.mock('../state/orders.atoms', () => {
  const { atom } = jest.requireActual<typeof import('jotai')>('jotai')
  const { solanaConnectionAtom } = jest.requireMock<typeof import('entities/solana')>('entities/solana')
  const saved = atom<Record<string, import('../state/orders.atoms').SavedNativeSolanaOrder>>({})
  const status = atom({ data: undefined, isError: false })
  return {
    activeSolanaReceiptAtom: atom(null),
    savedNativeSolanaOrdersAtom: saved,
    visibleNativeSolanaOrdersAtom: atom((get) =>
      Object.values(get(saved)).filter((order) => order.owner === get(solanaConnectionAtom)?.account.address),
    ),
    nativeSolanaOrderQueryAtom: () => status,
  }
})

function connection(address: string): SolanaConnection {
  return { account: { address }, wallet: { name: 'Solana wallet' } } as SolanaConnection
}

it.each([false, true])('opens recent trades from the connected header (EVM connected: %s)', async (evmConnected) => {
  mockEvmConnected = evmConnected
  const owner = evmConnected
    ? 'CaseSensitiveBase58KeyWithBothWa11ets111111'
    : 'CaseSensitiveBase58KeySo1anaOn1y11111111111'
  mockFetchTrades.mockReset().mockImplementation(async (_api: string, address: string, offset: number) =>
    Array.from({ length: offset === 0 ? 10 : 1 }, (_, index) => ({
      txSignature: '2'.repeat(63) + '123456789A'[(offset + index) % 10],
      owner: address,
      sellAmount: '120',
      sellToken: 'soldMint',
      instructionIndex: 0,
      orderUid: 'order' + (offset + index),
      buyAmount: '100',
      buyToken: 'mint',
      protocolFee: null,
      feeMint: null,
    })),
  )
  const store = createStore()
  store.set(solanaConnectionAtom, connection(owner))
  store.set(savedNativeSolanaOrdersAtom, {
    order10: {
      uid: 'order10',
      owner,
      intent: [],
      signature: null,
      reclaimed: false,
      program: 'program',
      genesis: 'genesis',
      orderPda: 'pda',
      createdBy: owner,
    },
  })
  render(
    <Provider store={store}>
      <I18nProvider i18n={setupI18n({ locale: 'en', messages: { en: {} } })}>
        <ThemeProvider theme={getCowswapTheme(false)}>
          <MemoryRouter>
            <AccountElement />
            <NativeSolanaOrders />
            <OrdersPanel />
          </MemoryRouter>
        </ThemeProvider>
      </I18nProvider>
    </Provider>,
  )
  expect(screen.queryByText('Settled trades')).toBeNull()
  expect(mockFetchTrades).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: evmConnected ? mockEvm : 'Account' }))
  const recent = within(await screen.findByRole('region', { name: 'Recent Activity' }))
  expect(await recent.findByText(owner)).toBeTruthy()
  expect(!!recent.queryByText('evm-order')).toBe(evmConnected)
  expect(!!screen.queryByText(/EVM wallet/)).toBe(evmConnected)
  fireEvent.click((await recent.findAllByRole('button', { name: /View receipt/ }))[0])
  const link = (await recent.findAllByRole('link', { name: /Solana Explorer/ }))[0]
  expect(link.getAttribute('href')).toBe('https://explorer.solana.com/tx/' + '2'.repeat(63) + '1')
  fireEvent.click(recent.getByRole('button', { name: 'Back' }))
  expect(recent.getByRole('button', { name: /View order.*order10/ })).toBeTruthy()
  fireEvent.click(recent.getByRole('button', { name: 'Show more trades' }))
  await waitFor(() => expect(mockFetchTrades).toHaveBeenCalledWith(expect.anything(), owner, 10, 10))
  await waitFor(() => expect(recent.getAllByRole('button', { name: /View receipt/ })).toHaveLength(11))
  expect(recent.queryByRole('button', { name: /View order.*order10/ })).toBeNull()
  act(() => store.set(solanaConnectionAtom, connection(owner + 'Changed')))
  await waitFor(() => expect(mockFetchTrades).toHaveBeenCalledWith(expect.anything(), owner + 'Changed', 0, 10))
  expect(recent.queryByText(owner)).toBeNull()
  expect(recent.queryByRole('button', { name: 'Show fewer trades' })).toBeNull()
  act(() => store.set(solanaConnectionAtom, null))
  if (evmConnected) {
    expect(recent.getByText('evm-order')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close account' }))
  } else {
    expect(screen.queryByRole('button', { name: 'Account' })).toBeNull()
    act(() => store.set(solanaConnectionAtom, connection(owner)))
  }
  expect(screen.queryByRole('region', { name: /Recent Activity/ })).toBeNull()
})
