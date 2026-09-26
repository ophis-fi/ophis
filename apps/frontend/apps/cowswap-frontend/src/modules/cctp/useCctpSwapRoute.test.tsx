import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { useIsBridgingEnabled } from '@cowprotocol/common-hooks'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { AccountType } from '@cowprotocol/types'
import { useAccountType, useIsSmartContractWallet } from '@cowprotocol/wallet'

import { renderHook } from '@testing-library/react'
import { cctpBuyTokens } from 'entities/cctp'

import { type BtcSwapPending } from './btcSwapState'
import { type CctpQuote, type CctpTransfer } from './cctp.service'
import { useCctpSwapRoute } from './useCctpSwapRoute'

jest.mock('@cowprotocol/common-hooks', () => ({ useIsBridgingEnabled: jest.fn(() => true) }))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x0000000000000000000000000000000000000001' }),
  useIsSmartContractWallet: jest.fn(() => false),
  useAccountType: jest.fn(),
}))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))
jest.mock('./useBtcCctpSwap', () => ({ useBtcCctpSwap: () => ({ pending: mockPending, quote: null }) }))
jest.mock('./useCctpTransfer', () => ({
  useCctpTransfer: () => ({ quote: mockQuote, transfer: mockTransfer, busy: '' }),
}))

let mockQuote: CctpQuote | null = null
let mockPending: BtcSwapPending | null = null

const mockTransfer: CctpTransfer = {
  source: 1,
  destination: 5042,
  owner: '0x0000000000000000000000000000000000000001',
  amount: '1000000',
  maxFee: '0',
  quotedAt: 1000,
}
const input = cctpBuyTokens({ sellChainId: ARC_CHAIN_ID, buyChainId: 1 }).find((token) => token.symbol === 'USDC')
const output = cctpBuyTokens({ sellChainId: 1, buyChainId: ARC_CHAIN_ID }).find((token) => token.symbol === 'USDC')
const params = {
  enabled: true,
  input,
  output,
  amount: null,
  recipient: null,
  recipientAddress: null,
  orderKind: OrderKind.SELL,
}

beforeEach(() => {
  mockQuote = null
  mockPending = null
  jest.mocked(useIsBridgingEnabled).mockReturnValue(true)
  jest.mocked(useIsSmartContractWallet).mockReturnValue(false)
  jest.mocked(useAccountType).mockReturnValue(AccountType.EOA)
})

it.each([undefined, AccountType.EIP7702EOA, AccountType.SMART_CONTRACT])(
  'keeps generic routing for unresolved or code-bearing accounts (%s)',
  (accountType) => {
    jest.mocked(useAccountType).mockReturnValue(accountType)
    const { result } = renderHook(() => useCctpSwapRoute(params))
    expect(result.current.active).toBe(false)
    expect(result.current.blocked).toBeTruthy()
    expect(result.current.params).toEqual({})
    expect(result.current.flow.quote).toBeNull()
  },
)

it('activates only a selected CCTP route and keeps unrelated swaps usable while recovery remains available', () => {
  const { result, rerender } = renderHook(({ output }) => useCctpSwapRoute({ ...params, output }), {
    initialProps: { output },
  })
  expect(result.current.active).toBe(true)
  expect(result.current.params.disableQuotePolling).toBe(true)
  expect(result.current.params.disableTokenSwitch).toBe(true)
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

it('requires the normal swap screen to opt in, keeping hooks execution on the generic trade path', () => {
  const { result } = renderHook(() => useCctpSwapRoute({ ...params, enabled: false }))
  expect(result.current.asset).toBeUndefined()
  expect(result.current.active).toBe(false)
  expect(result.current.params).toEqual({})
  expect(result.current.flow.quote).toBeNull()
  expect(result.current.flow.transfer).toBe(mockTransfer)
})

it('keeps a bound recovered BTC bridge quote usable on an unrelated picker pair', () => {
  mockPending = {
    type: 'wbtcToArc',
    owner: mockTransfer.owner,
    orderUid: `0x${'ab'.repeat(56)}`,
    sellAmount: '1000000',
    minimumBuyAmount: '990000',
    validTo: 1000,
  }
  mockQuote = { ...mockTransfer, asset: 'cirBTC', swapOrderUid: mockPending.orderUid }
  const { result, rerender } = renderHook(() => useCctpSwapRoute({ ...params, output: input }))
  expect(result.current.active).toBe(false)
  expect(result.current.flow.quote).toBe(mockQuote)
  expect(result.current.output).toBeNull()
  mockQuote = { ...mockQuote, owner: '0x0000000000000000000000000000000000000002' }
  rerender()
  expect(result.current.flow.quote).toBeNull()
  mockQuote = { ...mockQuote, owner: mockTransfer.owner, swapOrderUid: `0x${'cd'.repeat(56)}` }
  rerender()
  expect(result.current.flow.quote).toBeNull()
})

it('does not show recovered cirBTC raw units as another active CCTP pair output', () => {
  mockPending = {
    type: 'wbtcToArc',
    owner: mockTransfer.owner,
    orderUid: `0x${'ab'.repeat(56)}`,
    sellAmount: '1000000',
    minimumBuyAmount: '990000',
    validTo: 1000,
  }
  mockQuote = { ...mockTransfer, asset: 'cirBTC', swapOrderUid: mockPending.orderUid }
  const { result } = renderHook(() => useCctpSwapRoute(params))
  expect(result.current.active).toBe(true)
  expect(result.current.flow.quote).toBe(mockQuote)
  expect(result.current.output).toBeNull()
})
