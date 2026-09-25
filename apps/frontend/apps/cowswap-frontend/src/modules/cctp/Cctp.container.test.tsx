import { createStore, Provider } from 'jotai'
import { type ReactNode } from 'react'

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'

import { CctpSwapDetails, CctpSwapRecovery } from './Cctp.container'
import { CCTP_STORAGE_KEY, cctpStorage, cctpTransferAtom } from './cctpState'
import { type useCctpSwapRoute } from './useCctpSwapRoute'
import { useCctpTransfer } from './useCctpTransfer'

jest.mock('legacy/state/application/hooks', () => ({ useToggleWalletModal: jest.fn() }))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x0000000000000000000000000000000000000001', chainId: 1 }),
}))
jest.mock('./useCctpWallet', () => ({ useCctpWallet: () => undefined }))
jest.mock('./useCctpStatus', () => ({ useCctpStatus: () => ({ status: null, error: null }) }))

it('keeps the CCTP constraint visible without replacing generic provider actions', () => {
  const route = {
    active: false,
    asset: 'USDC',
    blocked: 'CCTP delivers to your connected wallet. Clear the custom recipient to continue.',
    flow: { transfer: null },
  } as ReturnType<typeof useCctpSwapRoute>
  const { rerender } = render(<CctpSwapRecovery route={route} />)
  expect(screen.getByRole('status').textContent).toBe(route.blocked)
  expect(screen.queryByRole('button')).toBeNull()
  rerender(<CctpSwapRecovery route={{ ...route, asset: undefined }} />)
  expect(screen.queryByRole('status')).toBeNull()
})

it('allows an approved user to refresh an expired quote without editing or reloading', () => {
  const loadQuote = jest.fn()
  const route = {
    active: true,
    asset: 'USDC',
    blocked: null,
    flow: {
      transfer: null,
      approved: true,
      busy: '',
      loadQuote,
      quote: {
        source: 1,
        destination: 5042,
        owner: '0x0000000000000000000000000000000000000001',
        amount: '1000000',
        maxFee: '1000',
        quotedAt: 1,
      },
    },
  } as unknown as ReturnType<typeof useCctpSwapRoute>
  render(<CctpSwapDetails route={route} source={1} destination={5042} amount="1" />)
  expect(screen.getByRole('button', { name: 'Bridge USDC' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh bridge fee' }))
  expect(loadQuote).toHaveBeenCalledWith(1, 5042, '1', 'USDC')
})

it.each([{ burnHash: 'invalid' }, false])(
  'preserves malformed recovery data and shows it beside unrelated swaps: %p',
  (saved) => {
    const store = createStore()
    store.set(cctpTransferAtom, saved)
    const wrapper = ({ children }: { children: ReactNode }): ReactNode => <Provider store={store}>{children}</Provider>
    const { result } = renderHook(() => useCctpTransfer('ordinary-swap'), { wrapper })
    expect(result.current.transfer).toBeNull()
    expect(result.current.recoveryError).toContain('Saved bridge data is invalid')
    const route = {
      active: false,
      asset: undefined,
      blocked: null,
      flow: result.current,
    } as ReturnType<typeof useCctpSwapRoute>
    const { rerender } = render(<CctpSwapRecovery route={route} />)
    expect(screen.getByRole('alert').textContent).toBe(result.current.recoveryError)
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<CctpSwapDetails route={route} source={1} destination={5042} amount="1" />)
    expect(screen.getByRole('alert').textContent).toBe(result.current.recoveryError)
    expect(screen.queryByRole('button')).toBeNull()
    act(() => result.current.finish())
    expect(cctpStorage.getItem(CCTP_STORAGE_KEY, null)).toEqual(saved)
    cctpStorage.setItem(CCTP_STORAGE_KEY, null)
  },
)
