import { createStore } from 'jotai'

import { RelayBridgeProvider } from '@cowprotocol/common-const'
import { BridgeStatus } from '@cowprotocol/sdk-bridging'

import { fireEvent, render, screen } from '@testing-library/react'

import { arcReceiptAtom } from './arcReceipt.atoms'
import { ArcOutboundRecovery } from './ArcOutboundRecovery.container'

jest.mock('legacy/state/application/hooks', () => ({ useToggleWalletModal: jest.fn() }))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: false }))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x1111111111111111111111111111111111111111' }),
}))

const key = 'ophisArcBridge:0x1111111111111111111111111111111111111111:v0'

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

it('uses a single record across address spellings and fails if the browser cannot persist it', () => {
  const owner = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
  const atom = arcReceiptAtom(owner)
  expect(arcReceiptAtom(owner.toUpperCase().replace('0X', '0x'))).toBe(atom)
  const store = createStore()
  const record = { provider: 'Relay', id: '0x' + '12'.repeat(32), destination: 8453, minimum: '999', nonce: 5 }
  store.set(atom, record)
  expect(JSON.parse(localStorage.getItem('ophisArcBridge:' + owner + ':v0') || 'null')).toEqual(record)
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
  expect(() => store.set(atom, { ...record, nonce: 6 })).toThrow('Unable to save Arc bridge tracking')
})
