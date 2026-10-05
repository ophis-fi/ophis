import { Provider } from 'jotai'
import { ReactNode } from 'react'

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { useStarknetWallet } from './hooks/useStarknetWallet'
import { StarknetWallet } from './starknetWallet.service'
import { StarknetWalletConnect } from './StarknetWalletConnect.container'

const mockDiscover = jest.fn()
const mockEnable = jest.fn()
jest.mock('@starknet-io/get-starknet-core', () => ({
  __esModule: true,
  default: { getAvailableWallets: () => mockDiscover(), enable: (wallet: unknown) => mockEnable(wallet) },
}))
jest.mock('@cowprotocol/ui', () => ({
  UI: {},
  ButtonSecondary: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}))
const address = '0x01' + '11'.repeat(31)
const events = new Map<string, Set<() => void>>()
const wallet = {
  id: 'braavos',
  name: 'Braavos',
  version: '1',
  icon: '',
  request: jest.fn(async ({ type }: { type: string }) =>
    type === 'wallet_requestAccounts' ? [address] : '0x534e5f4d41494e',
  ),
  on: (event: string, cb: () => void) => {
    const set = events.get(event) ?? new Set()
    set.add(cb)
    events.set(event, set)
  },
  off: (event: string, cb: () => void) => {
    events.get(event)?.delete(cb)
  },
} as unknown as StarknetWallet

function Host({ show = true, onConnect }: { show?: boolean; onConnect(address: string): void }): ReactNode {
  const { connection } = useStarknetWallet()
  return (
    <>
      <span>{connection ? 'Account active' : 'Account disconnected'}</span>
      {show && <StarknetWalletConnect onConnect={onConnect} />}
    </>
  )
}

beforeEach(() => {
  events.clear()
  mockDiscover.mockReset().mockResolvedValue([wallet])
  mockEnable.mockReset().mockResolvedValue(wallet)
})
async function open(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Connect Starknet wallet' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Braavos' }))
}

it('enables a discovered candidate and fills the refund address from the resolved wallet', async () => {
  const onConnect = jest.fn()
  const virtual = { id: 'braavos', name: 'Braavos', loadWallet: jest.fn() }
  mockDiscover.mockResolvedValue([virtual])
  render(
    <Provider>
      <Host onConnect={onConnect} />
    </Provider>,
  )
  await open()
  await waitFor(() => expect(onConnect).toHaveBeenCalledWith(address))
  expect(mockEnable).toHaveBeenCalledWith(virtual)
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Starknet wallet' }))
  expect(screen.getByText('Account disconnected')).toBeTruthy()
})

it.each(['accountsChanged', 'networkChanged'])(
  'invalidates %s while confirmation hides the connection control',
  async (event) => {
    const onConnect = jest.fn()
    const view = render(
      <Provider>
        <Host onConnect={onConnect} />
      </Provider>,
    )
    await open()
    await screen.findByText('Account active')
    view.rerender(
      <Provider>
        <Host show={false} onConnect={onConnect} />
      </Provider>,
    )
    act(() => {
      events.get(event)?.forEach((callback) => callback())
    })
    expect(screen.getByText('Account disconnected')).toBeTruthy()
  },
)

it('ignores a connection completed after leaving the source form', async () => {
  const onConnect = jest.fn()
  let complete: (wallet: StarknetWallet) => void = () => undefined
  mockEnable.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const view = render(
    <Provider>
      <Host onConnect={onConnect} />
    </Provider>,
  )
  await open()
  await waitFor(() => expect(mockEnable).toHaveBeenCalled())
  view.rerender(
    <Provider>
      <Host show={false} onConnect={onConnect} />
    </Provider>,
  )
  await act(async () => {
    complete(wallet)
  })
  expect(onConnect).not.toHaveBeenCalled()
  expect(screen.getByText('Account disconnected')).toBeTruthy()
})

it('offers a usable external-wallet fallback when nothing is installed', async () => {
  mockDiscover.mockResolvedValue([])
  render(
    <Provider>
      <Host onConnect={jest.fn()} />
    </Provider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Connect Starknet wallet' }))
  expect(await screen.findByText(/No Starknet wallet detected/)).toBeTruthy()
})

it('keeps rejection recoverable without accepting a refund address', async () => {
  const onConnect = jest.fn()
  mockEnable.mockRejectedValue(new Error('Connection declined'))
  render(
    <Provider>
      <Host onConnect={onConnect} />
    </Provider>,
  )
  await open()
  expect((await screen.findByRole('alert')).textContent).toBe('Connection declined')
  expect(onConnect).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Connect Starknet wallet' }).hasAttribute('disabled')).toBe(false)
})
