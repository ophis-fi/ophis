import { renderHook } from '@testing-library/react'

import fixture from '../fixtures/monadDeposit.json'

import { useNearSwapAddresses } from './useNearSwapAddresses'

let mockLoading = false
let mockIntegrityError = false
const mockAddress = fixture.response.quoteRequest.recipient
jest.mock('common/hooks/useOphisNameResolution', () => ({
  useOphisNameResolution: (value: string) => ({
    address: value === 'owner.eth' ? mockAddress : value,
    loading: mockLoading,
    integrityError: mockIntegrityError,
  }),
}))

it('uses the resolved address and blocks unresolved or invalid recipients', () => {
  const { result, rerender } = renderHook(
    ({ recipient }) =>
      useNearSwapAddresses(fixture.source, fixture.destination, fixture.response.quoteRequest.refundTo, recipient),
    { initialProps: { recipient: 'owner.eth' } },
  )
  expect(result.current.recipient).toBe(mockAddress)
  expect(result.current.refundTo).toBe(fixture.response.quoteRequest.refundTo)
  mockLoading = true
  rerender({ recipient: 'owner.eth' })
  expect(result.current.recipient).toBe('')
  mockLoading = false
  mockIntegrityError = true
  rerender({ recipient: 'owner.eth' })
  expect(result.current.recipient).toBe('')
  mockIntegrityError = false
  rerender({ recipient: 'invalid-address' })
  expect(result.current.recipient).toBe('')
})
