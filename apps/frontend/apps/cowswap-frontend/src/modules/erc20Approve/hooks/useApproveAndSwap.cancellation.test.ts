import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { renderHook } from '@testing-library/react'

import { useApproveAndSwap } from './useApproveAndSwap'
import { useApproveCurrency } from './useApproveCurrency'
import { useGeneratePermitInAdvanceToTrade } from './useGeneratePermitInAdvanceToTrade'

import { LinguiWrapper } from '../../../../LinguiJestProvider'
import { useHandleApprovalError } from '../containers/TradeApproveModal/useHandleApprovalError'

jest.mock('@cowprotocol/balances-and-allowances', () => ({
  useTradeSpenderAddress: () => '0x1111111111111111111111111111111111111111',
}))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x2222222222222222222222222222222222222222' }),
}))
jest.mock('modules/permit', () => ({ useTokenSupportsPermit: () => true }))
jest.mock('../state', () => ({ useUpdateApproveProgressModalState: () => jest.fn() }))
jest.mock('./useApproveCurrency')
jest.mock('./useGeneratePermitInAdvanceToTrade')
jest.mock('../containers/TradeApproveModal/useHandleApprovalError')

const amount = CurrencyAmount.fromRawAmount(new Token(5042, '0x3600000000000000000000000000000000000000', 6), '1000000')

it.each([4001, 'ACTION_REJECTED'])('stops after permit cancellation %s without approval or swap', async (code) => {
  const error = Object.assign(new Error('User rejected the request'), { code })
  const approve = jest.fn()
  const confirm = jest.fn()
  const handleError = jest.fn()
  jest.mocked(useApproveCurrency).mockReturnValue(approve)
  jest.mocked(useGeneratePermitInAdvanceToTrade).mockReturnValue(jest.fn().mockRejectedValue(error))
  jest.mocked(useHandleApprovalError).mockReturnValue(handleError)
  const { result } = renderHook(() => useApproveAndSwap({ amountToApprove: amount, onApproveConfirm: confirm }), {
    wrapper: LinguiWrapper,
  })

  await expect(result.current()).resolves.toBeUndefined()

  expect(handleError).toHaveBeenCalledWith(error)
  expect(approve).not.toHaveBeenCalled()
  expect(confirm).not.toHaveBeenCalled()
})

it('still falls back to approval when permit generation is unavailable', async () => {
  const approve = jest.fn().mockResolvedValue(null)
  const confirm = jest.fn()
  const handleError = jest.fn()
  jest.mocked(useApproveCurrency).mockReturnValue(approve)
  jest.mocked(useGeneratePermitInAdvanceToTrade).mockReturnValue(jest.fn().mockResolvedValue(false))
  jest.mocked(useHandleApprovalError).mockReturnValue(handleError)
  const { result } = renderHook(() => useApproveAndSwap({ amountToApprove: amount, onApproveConfirm: confirm }), {
    wrapper: LinguiWrapper,
  })

  await result.current()

  expect(approve).toHaveBeenCalledWith(1000000n)
  expect(handleError).not.toHaveBeenCalled()
  expect(confirm).not.toHaveBeenCalled()
})
