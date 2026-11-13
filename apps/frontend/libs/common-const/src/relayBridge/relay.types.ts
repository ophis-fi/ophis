import { EvmCall, TokenInfo } from '@cowprotocol/cow-sdk'
import { BridgeQuoteResult, HookBridgeProvider, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

export interface RelayCurrency {
  id: string
  address: string
  decimals: number
  supportsBridging: boolean
}
export interface RelayChain {
  id: number
  disabled: boolean
  depositEnabled: boolean
  currency: RelayCurrency
  erc20Currencies: RelayCurrency[]
}
export interface RelayInput {
  payment: { chainId: string; currency: string; amount: string; weight: string }
  refunds: {
    chainId: string
    recipient: string
    currency: string
    minimumAmount: string
    deadline: number
    extraData: string
  }[]
}
export interface RelayOrder {
  version: string
  solverChainId: string
  solver: string
  salt: string
  inputs: RelayInput[]
  output: {
    chainId: string
    payments: { recipient: string; currency: string; minimumAmount: string; expectedAmount: string }[]
    calls: string[]
    deadline: number
    extraData: string
  }
  fees: { recipientChainId: string; recipient: string; currencyChainId: string; currency: string; amount: string }[]
}
export interface RelayResponse {
  requestId: string
  protocol: { v2: { orderId: string; orderData: RelayOrder; orderSignature: string; hubType: string } }
  details: {
    timeEstimate: number
    currencyOut: { amount: string; minimumAmount: string }
  }
}
export interface RelayQuote extends BridgeQuoteResult {
  relay: RelayResponse
  request: QuoteBridgeRequest
  depositUntil: number
}
export interface RelayHookTerms {
  owner: string
  shed: string
  request: QuoteBridgeRequest
  quote: RelayQuote
}
export interface RelayProviderOptions {
  enabled?: boolean
  apiUrl?: string
  trustedTokens?: () => Promise<TokenInfo[]>
  sourceChainIds?: ReadonlySet<number>
  signHook?: (
    terms: RelayHookTerms,
    ...args: Parameters<HookBridgeProvider<RelayQuote>['getSignedHook']>
  ) => ReturnType<HookBridgeProvider<RelayQuote>['getSignedHook']>
}
export type RelayProgram = { call: EvmCall; terms: RelayHookTerms }
