import { AdditionalTargetChainId, BTC_CURRENCY_ADDRESS } from '@cowprotocol/cow-sdk'
import { Token } from '@cowprotocol/currency'

import { isBridgeQuoteRecipientCurrent } from './isBridgeQuoteRecipientCurrent.utils'

import type { TradeFlowContext } from '../types/TradeFlowContext'

const SOL_RECIPIENT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const EVM_RECIPIENT = '0x1234567890123456789012345678901234567890'

function context(
  chainId: number = AdditionalTargetChainId.SOLANA,
  recipient: string | null = SOL_RECIPIENT,
): TradeFlowContext {
  const tokenAddress = recipient && chainId !== AdditionalTargetChainId.SOLANA ? recipient : SOL_RECIPIENT
  return {
    orderParams: {
      sellToken: new Token(1, EVM_RECIPIENT, 6),
      buyToken: new Token(chainId, tokenAddress, 6),
      recipient,
      recipientAddressOrName: recipient,
    },
    tradeQuote: { quoteResults: { tradeParameters: { sellToken: EVM_RECIPIENT } } },
    tradeQuoteState: {
      bridgeQuote: {
        providerInfo: { type: 'ReceiverAccountBridgeProvider' },
        tradeParameters: {
          sellTokenChainId: 1,
          sellTokenAddress: '0x9876543210987654321098765432109876543210',
          buyTokenChainId: chainId,
          buyTokenAddress: tokenAddress,
          receiver: recipient,
        },
      },
    },
  } as unknown as TradeFlowContext
}

it.each([
  [AdditionalTargetChainId.SOLANA, SOL_RECIPIENT],
  [AdditionalTargetChainId.BITCOIN, BTC_CURRENCY_ADDRESS],
  [10, EVM_RECIPIENT],
])('accepts a quote bound to the current chain and recipient (%s)', (chainId, recipient) => {
  expect(isBridgeQuoteRecipientCurrent(context(chainId, recipient))).toBe(true)
})

it.each([
  { receiver: SOL_RECIPIENT.toLowerCase() },
  { receiver: EVM_RECIPIENT },
  { receiver: undefined },
  { receiver: SOL_RECIPIENT, bridgeRecipient: 'So11111111111111111111111111111111111111112' },
  { buyTokenChainId: AdditionalTargetChainId.BITCOIN },
  { sellTokenChainId: 10 },
  { buyTokenAddress: 'So11111111111111111111111111111111111111112' },
])('rejects a missing, stale or overridden destination: %j', (changes) => {
  const trade = context()
  const quote = trade.tradeQuoteState.bridgeQuote
  if (!quote) throw new Error('Missing test quote')
  const stale = {
    ...trade,
    tradeQuoteState: {
      ...trade.tradeQuoteState,
      bridgeQuote: { ...quote, tradeParameters: { ...quote.tradeParameters, ...changes } },
    },
  }
  expect(isBridgeQuoteRecipientCurrent(stale)).toBe(false)
})

it.each([null, '', EVM_RECIPIENT, BTC_CURRENCY_ADDRESS])('rejects an invalid Solana recipient: %s', (recipient) => {
  expect(isBridgeQuoteRecipientCurrent(context(AdditionalTargetChainId.SOLANA, recipient))).toBe(false)
})

it('rejects missing non-EVM quotes and stale ENS-derived order recipients', () => {
  const trade = context()
  expect(
    isBridgeQuoteRecipientCurrent({ ...trade, tradeQuoteState: { ...trade.tradeQuoteState, bridgeQuote: null } }),
  ).toBe(false)
  expect(
    isBridgeQuoteRecipientCurrent({ ...trade, orderParams: { ...trade.orderParams, recipient: EVM_RECIPIENT } }),
  ).toBe(false)
  expect(
    isBridgeQuoteRecipientCurrent({
      ...trade,
      orderParams: { ...trade.orderParams, sellToken: new Token(1, '0x9876543210987654321098765432109876543210', 6) },
    }),
  ).toBe(false)
})

it('keeps non-bridge EVM swaps available without a bridge quote', () => {
  const trade = context(1, EVM_RECIPIENT)
  expect(
    isBridgeQuoteRecipientCurrent({ ...trade, tradeQuoteState: { ...trade.tradeQuoteState, bridgeQuote: null } }),
  ).toBe(true)
})
