import { ARC_USDC } from '@cowprotocol/common-const'
import { CurrencyAmount } from '@cowprotocol/currency'

import { cctpBuyTokens } from 'entities/cctp'
import { encodeFunctionData, pad, zeroHash, type Hex } from 'viem'

import {
  ACROSS_DEPOSIT_ABI,
  ARC_SPOKE_POOL,
  assertAcrossQuote,
  isArcAcrossRoute,
  parseAcrossQuote,
} from './acrossQuote.service'

jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))
const owner = '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A' as const
const inputToken = '0x3600000000000000000000000000000000000000' as const
const outputToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const
const now = 1791055000000
const request = { owner, recipient: owner, destination: 8453, amount: '1000000' }
function response(
  overrides: Partial<{
    recipient: Hex
    output: Hex
    amount: bigint
    received: bigint
    chain: bigint
    message: Hex
  }> = {},
): unknown {
  const args = [
    pad(owner),
    overrides.recipient ?? pad(owner),
    pad(inputToken),
    overrides.output ?? pad(outputToken),
    overrides.amount ?? 1000000n,
    overrides.received ?? 996000n,
    overrides.chain ?? 8453n,
    zeroHash,
    now / 1000 - 120,
    now / 1000 + 7200,
    0,
    overrides.message ?? '0x',
  ] as const
  return {
    crossSwapType: 'bridgeableToBridgeable',
    amountType: 'exactInput',
    inputAmount: '1000000',
    maxInputAmount: '1000000',
    expectedOutputAmount: '996000',
    minOutputAmount: '996000',
    quoteExpiryTimestamp: now / 1000 + 3600,
    swapTx: {
      chainId: 5042,
      to: ARC_SPOKE_POOL,
      data: encodeFunctionData({ abi: ACROSS_DEPOSIT_ABI, functionName: 'deposit', args }) + '1dc0de031173c0de',
    },
  }
}
beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now))
afterEach(() => jest.restoreAllMocks())

it('validates an exact Arc USDC deposit and preserves the integrator tag', () => {
  const quote = parseAcrossQuote(response(), request)
  expect(quote.output).toBe('996000')
  expect(quote.expiresAt).toBe(now + 60000)
  expect(quote.data.endsWith('1dc0de031173c0de')).toBe(true)
  expect(() => assertAcrossQuote(quote)).not.toThrow()
})
it.each([
  { recipient: zeroHash },
  { output: zeroHash },
  { amount: 1000000000000000000n },
  { received: 1n },
  { chain: 1n },
  { message: '0x1234' as Hex },
])('rejects calldata that changes reviewed terms: %#', (overrides) => {
  expect(() => parseAcrossQuote(response(overrides), request)).toThrow()
})
it('expires the reviewed quote while keeping recovery data valid', () => {
  const quote = parseAcrossQuote(response(), request)
  jest.spyOn(Date, 'now').mockReturnValue(now + 60001)
  expect(() => assertAcrossQuote(quote)).toThrow('expired')
  expect(() => assertAcrossQuote(quote, false)).not.toThrow()
})
it('routes outbound Arc USDC through Across without affecting inbound or other assets', () => {
  const base = cctpBuyTokens({ sellChainId: ARC_USDC.chainId, buyChainId: 8453 }).find((t) => t.symbol === 'USDC')
  expect(base).toBeDefined()
  expect(isArcAcrossRoute(ARC_USDC, base)).toBe(true)
  expect(isArcAcrossRoute(base, ARC_USDC)).toBe(false)
  expect(isArcAcrossRoute(ARC_USDC, ARC_USDC)).toBe(false)
  expect(CurrencyAmount.fromRawAmount(ARC_USDC, '1000000').toExact()).toBe('1')
})
