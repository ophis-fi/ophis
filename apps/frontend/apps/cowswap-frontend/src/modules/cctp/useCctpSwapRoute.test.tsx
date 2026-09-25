import { useIsBridgingEnabled } from '@cowprotocol/common-hooks'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { useIsSmartContractWallet } from '@cowprotocol/wallet'

import { renderHook } from '@testing-library/react'
import { cctpBuyTokens } from 'entities/cctp'

import { type CctpTransfer } from './cctp.service'
import { useCctpSwapRoute } from './useCctpSwapRoute'

jest.mock('@cowprotocol/common-hooks', () => ({ useIsBridgingEnabled: jest.fn(() => true) }))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x0000000000000000000000000000000000000001' }),
  useIsSmartContractWallet: jest.fn(() => false),
}))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))
jest.mock('./useCctpTransfer', () => ({
  useCctpTransfer: () => ({ quote: null, transfer: mockTransfer, busy: '' }),
}))

const mockTransfer: CctpTransfer = {
  source: 1,
  destination: 5042,
  owner: '0x0000000000000000000000000000000000000001',
  amount: '1000000',
  maxFee: '0',
  quotedAt: 1000,
}
const input = cctpBuyTokens({ sellChainId: 5042, buyChainId: 1 }).find((token) => token.symbol === 'USDC')
const output = cctpBuyTokens({ sellChainId: 1, buyChainId: 5042 }).find((token) => token.symbol === 'USDC')
const params = { input, output, amount: null, recipient: null, recipientAddress: null, orderKind: OrderKind.SELL }

beforeEach(() => {
  jest.mocked(useIsBridgingEnabled).mockReturnValue(true)
  jest.mocked(useIsSmartContractWallet).mockReturnValue(false)
})

it('activates only a selected CCTP route and keeps unrelated swaps usable while recovery remains available', () => {
  const { result, rerender } = renderHook(({ output }) => useCctpSwapRoute({ ...params, output }), {
    initialProps: { output },
  })
  expect(result.current.active).toBe(true)
  expect(result.current.params.disableQuotePolling).toBe(true)
  rerender({ output: input })
  expect(result.current.active).toBe(false)
  expect(result.current.params).toEqual({})
  expect(result.current.flow.transfer).toBe(mockTransfer)
})

it.each(['smart wallet', 'custom recipient'])('keeps generic provider quoting available for a %s', (constraint) => {
  jest.mocked(useIsSmartContractWallet).mockReturnValue(constraint === 'smart wallet')
  const recipient = constraint === 'custom recipient' ? '0x0000000000000000000000000000000000000002' : null
  const { result } = renderHook(() => useCctpSwapRoute({ ...params, recipient }))
  expect(result.current.asset).toBe('USDC')
  expect(result.current.blocked).toBeTruthy()
  expect(result.current.active).toBe(false)
  expect(result.current.params).toEqual({})
  expect(result.current.flow.quote).toBeNull()
})

it('honors the widget bridge kill switch without hiding transfer recovery', () => {
  const { result, rerender } = renderHook(() => useCctpSwapRoute(params))
  expect(result.current.active).toBe(true)
  jest.mocked(useIsBridgingEnabled).mockReturnValue(false)
  rerender()
  expect(result.current.active).toBe(false)
  expect(result.current.asset).toBeUndefined()
  expect(result.current.params).toEqual({})
  expect(result.current.flow.transfer).toBe(mockTransfer)
})
