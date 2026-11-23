import { RelayBridgeProvider } from '@cowprotocol/common-const'
import { BridgeStatus } from '@cowprotocol/sdk-bridging'

import { fireEvent, render, screen } from '@testing-library/react'

import { ArcOutboundRecovery } from './ArcOutbound.container'

jest.mock('legacy/state/application/hooks', () => ({ useToggleWalletModal: jest.fn() }))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: false }))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x1111111111111111111111111111111111111111' }),
}))

const key = 'ophisArcBridge:0x1111111111111111111111111111111111111111'

afterEach(() => {
  localStorage.clear()
  jest.restoreAllMocks()
})

it('resumes Relay tracking by request ID and shows the nonce of an ambiguous send', async () => {
  const id = '0x' + '12'.repeat(32)
  const getStatus = jest.spyOn(RelayBridgeProvider.prototype, 'getStatus').mockResolvedValue({
    status: BridgeStatus.EXECUTED,
    fillTxHash: '0x' + '23'.repeat(32),
  })
  localStorage.setItem(key, JSON.stringify({ provider: 'Relay', id, destination: 8453, minimum: '999', nonce: 5 }))
  render(<ArcOutboundRecovery />)
  expect(await screen.findByText(/Provider confirmed delivery/)).toBeTruthy()
  expect(getStatus).toHaveBeenCalledWith(id, 5042)
  expect(screen.getByText(/nonce 5/)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Track on Relay' }).getAttribute('href')).toContain(id)
})

it('requires confirmation to discard unreadable tracking and preserves a newer record', () => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_key: string, _options: unknown, fn: (lock: object) => void) => fn({}),
    },
  })
  localStorage.setItem(key, 'invalid')
  render(<ArcOutboundRecovery />)
  expect(screen.getByRole('alert').textContent).toContain('could not be read')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss tracking' }))
  expect(localStorage.getItem(key)).toBe('invalid')
  localStorage.setItem(key, 'newer')
  fireEvent.click(screen.getByRole('button', { name: 'Clear saved record' }))
  expect(localStorage.getItem(key)).toBe('newer')
})
