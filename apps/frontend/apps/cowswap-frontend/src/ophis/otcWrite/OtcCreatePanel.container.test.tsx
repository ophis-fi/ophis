import { fireEvent, render, screen } from '@testing-library/react'
import { decodeFunctionData } from 'viem'

import { buildOtcRevokeCreateApproval } from './buildOtcTransaction'
import { OtcActionControl } from './OtcActionControl.container'
import { OtcCreatePanel } from './OtcCreatePanel.container'
import { OTC_APPROVE_ABI } from './otcWrite.abi'

jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x1111111111111111111111111111111111111111' }),
}))
jest.mock('./useOtcUsdAmount', () => ({ useOtcUsdAmount: () => ({ value: null, isLoading: false }) }))
jest.mock('./OtcActionControl.container', () => ({ OtcActionControl: jest.fn(() => null) }))

const controlMock = jest.mocked(OtcActionControl)

it('can revoke from an empty form and keeps recovery bound to equivalent parsed amounts', () => {
  render(<OtcCreatePanel />)
  const emptyDefinition = controlMock.mock.calls.at(-1)?.[0].definition
  expect(emptyDefinition?.executeIntent).toBeNull()
  const revoke = emptyDefinition?.revokeIntent
  if (revoke?.kind !== 'revoke-create') throw new Error('Missing create allowance recovery')
  const request = buildOtcRevokeCreateApproval(revoke)
  expect(decodeFunctionData({ abi: OTC_APPROVE_ABI, data: request.data }).args?.[1]).toBe(0n)

  const makerAmount = screen.getByRole('textbox', { name: 'Maker escrow amount' })
  const requestedAmount = screen.getByRole('textbox', { name: 'Requested amount' })
  fireEvent.change(makerAmount, { target: { value: '1' } })
  fireEvent.change(requestedAmount, { target: { value: '2000' } })
  const originalKey = controlMock.mock.calls.at(-1)?.[0].definition.resetKey
  expect(originalKey).toBeDefined()
  fireEvent.change(makerAmount, { target: { value: '1.0' } })
  fireEvent.change(requestedAmount, { target: { value: '2000.00' } })
  expect(controlMock.mock.calls.at(-1)?.[0].definition.resetKey).toBe(originalKey)
  fireEvent.change(makerAmount, { target: { value: '2' } })
  expect(controlMock.mock.calls.at(-1)?.[0].definition.resetKey).not.toBe(originalKey)
})
