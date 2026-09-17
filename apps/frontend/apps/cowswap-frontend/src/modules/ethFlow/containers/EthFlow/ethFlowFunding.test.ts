import { ReactElement } from 'react'

import { useCurrencyAmountBalance } from '@cowprotocol/balances-and-allowances'
import { NATIVE_CURRENCIES, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { CurrencyAmount } from '@cowprotocol/currency'
import { useWalletInfo } from '@cowprotocol/wallet'

import { renderHook } from '@testing-library/react'

import { useApproveState } from 'modules/erc20Approve'

import { useEthFlowActions } from './hooks/useEthFlowActions'
import { useHandleChainChange } from './hooks/useHandleChainChange'
import useRemainingNativeTxsAndCosts from './hooks/useRemainingNativeTxsAndCosts'

import { EthFlowModalContentProps } from '../../pure/EthFlowModalContent'

import { EthFlowModal } from './index'

jest.mock('@cowprotocol/balances-and-allowances', () => ({ useCurrencyAmountBalance: jest.fn() }))
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: jest.fn() }))
jest.mock('legacy/hooks/useRecentActivity', () => ({ useSingleActivityDescriptor: () => null }))
jest.mock('modules/erc20Approve', () => ({
  useApproveState: jest.fn(() => ({ state: 3 })),
  useIsPartialApproveSelectedByUser: () => true,
  usePartialApproveAmountModalState: () => undefined,
  useTradeApproveCallback: () => jest.fn(),
  useUpdatePartialApproveAmountModalState: () => jest.fn(),
}))
jest.mock('modules/trade', () => ({
  useWrappedToken: () => jest.requireActual('@cowprotocol/common-const').WRAPPED_NATIVE_CURRENCIES[1],
}))
jest.mock('lib/hooks/useNativeCurrency', () => ({
  __esModule: true,
  default: () => jest.requireActual('@cowprotocol/common-const').NATIVE_CURRENCIES[1],
}))
jest.mock('./hooks/useEthFlowActions', () => ({ useEthFlowActions: jest.fn() }))
jest.mock('./hooks/useSetupEthFlow', () => ({ useSetupEthFlow: jest.fn() }))
jest.mock('./hooks/useRemainingNativeTxsAndCosts', () => ({
  __esModule: true,
  default: jest.fn(() => ({ balanceChecks: undefined })),
}))
jest.mock('../../pure/EthFlowModalContent', () => ({ EthFlowModalContent: () => null }))

const native = NATIVE_CURRENCIES[1]
const account = '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A'

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useWalletInfo).mockReturnValue({ chainId: 1, account } as ReturnType<typeof useWalletInfo>)
})

it.each([true, false])('keeps approval headroom and charges native value only when wrapping: funded=%s', (funded) => {
  const cap = CurrencyAmount.fromRawAmount(native, '1000000000000000000')
  const approval = CurrencyAmount.fromRawAmount(native, '1010000000000000000')
  jest.mocked(useCurrencyAmountBalance).mockReturnValue(CurrencyAmount.fromRawAmount(native, '10000000000000000'))
  const { result } = renderHook(() =>
    EthFlowModal({
      nativeInput: funded ? cap : approval,
      approvalInput: approval,
      hasEnoughWrappedBalanceForSwap: funded,
      wrapCallback: null,
      directSwapCallback: jest.fn(),
      onDismiss: jest.fn(),
    }),
  )
  const amount = jest.mocked(useApproveState).mock.calls[0][0]
  expect(amount?.currency).toBe(WRAPPED_NATIVE_CURRENCIES[1])
  expect(amount?.quotient.toString()).toBe(approval.quotient.toString())
  expect(jest.mocked(useEthFlowActions).mock.calls[0][1]).toBe(BigInt(approval.quotient.toString()))
  expect((result.current as ReactElement<EthFlowModalContentProps>).props.wrappingPreview.amount).toBe(approval)
  expect(jest.mocked(useRemainingNativeTxsAndCosts).mock.calls[0][0].nativeInput?.quotient.toString()).toBe(
    funded ? '0' : approval.quotient.toString(),
  )
})

it.each([undefined, '0x1111111111111111111111111111111111111111'])(
  'ignores account casing but dismisses when the account changes to %s',
  (nextAccount) => {
    const dismiss = jest.fn()
    const { rerender } = renderHook(() => useHandleChainChange(dismiss))
    jest
      .mocked(useWalletInfo)
      .mockReturnValue({ chainId: 1, account: account.toLowerCase() } as ReturnType<typeof useWalletInfo>)
    rerender()
    expect(dismiss).not.toHaveBeenCalled()
    jest.mocked(useWalletInfo).mockReturnValue({ chainId: 1, account: nextAccount } as ReturnType<typeof useWalletInfo>)
    rerender()
    expect(dismiss).toHaveBeenCalledTimes(1)
  },
)
