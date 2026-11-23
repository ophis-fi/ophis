import { createStore } from 'jotai'

import { RelayBridgeProvider } from '@cowprotocol/common-const'
import { BridgeStatus } from '@cowprotocol/sdk-bridging'

import { fireEvent, render, screen } from '@testing-library/react'

import { ArcOutboundRecovery } from './ArcOutboundRecovery.container'
import { arcReceiptAtom, type Receipt } from './arcReceipt.atoms'

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

it('requires confirmation to discard unreadable tracking and preserves a newer record', async () => {
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
  expect(await screen.findByText(/The saved transfer changed/)).toBeTruthy()
  expect(localStorage.getItem(key)).toBe('newer')
})

it('uses a single record across address spellings and fails if the browser cannot persist it', () => {
  const owner = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
  const atom = arcReceiptAtom(owner)
  expect(arcReceiptAtom(owner.toUpperCase().replace('0X', '0x'))).toBe(atom)
  const store = createStore()
  const record: Receipt = { provider: 'Relay', id: '0x' + '12'.repeat(32), destination: 8453, minimum: '999', nonce: 5 }
  store.set(atom, record)
  expect(JSON.parse(localStorage.getItem('ophisArcBridge:' + owner + ':v0') || 'null')).toEqual(record)
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
  expect(() => store.set(atom, { ...record, nonce: 6 })).toThrow('Unable to save Arc bridge tracking')
  expect(store.get(atom)).toEqual(record)
})

it('reports a busy tab and a storage failure, then allows clearing the same record on retry', async () => {
  const request = jest.fn((_key: string, _options: unknown, callback: (lock: object | null) => void) => callback({}))
  request.mockImplementationOnce((_key, _options, callback) => callback(null))
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  localStorage.setItem(key, 'unreadable')
  render(<ArcOutboundRecovery />)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss tracking' }))
  const clear = screen.getByRole('button', { name: 'Clear saved record' })
  fireEvent.click(clear)
  expect(await screen.findByText(/Another tab is updating/)).toBeTruthy()
  const write = jest.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {})
  fireEvent.click(clear)
  expect(await screen.findByText(/Unable to save Arc bridge tracking/)).toBeTruthy()
  expect(localStorage.getItem(key)).toBe('unreadable')
  write.mockRestore()
  fireEvent.click(clear)
  expect(screen.queryByRole('button', { name: 'Clear saved record' })).toBeNull()
  expect(localStorage.getItem(key)).toBe('null')
})
