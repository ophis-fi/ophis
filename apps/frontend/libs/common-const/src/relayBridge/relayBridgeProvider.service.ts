import { areAddressesEqual, ChainInfo, EvmCall, getGlobalAdapter, TokenInfo } from '@cowprotocol/cow-sdk'
import {
  BridgeDeposit,
  BridgeHook,
  BridgeProviderInfo,
  BuyTokensParams,
  GetProviderBuyTokens,
  HookBridgeProvider,
  QuoteBridgeRequest,
} from '@cowprotocol/sdk-bridging'
import { CowShedSdk } from '@cowprotocol/sdk-cow-shed'

import { RELAY_CHAINS, RELAY_DAPP_ID, RELAY_ENABLED } from './relay.constants'
import { RelayChain, RelayProgram, RelayProviderOptions, RelayQuote } from './relay.types'
import { relayAssert, verifyRelayQuote } from './relay.validation'
import { RelayApi } from './relayApi.service'
import { relayBridgingParams } from './relayHistory.service'
import { relayProgram } from './relayProgram.service'
import { relayQuote, sameRelayRequest } from './relayQuote.service'
import { relayStatus } from './relayStatus.service'
import { relayTokens } from './relayTokens.service'

import { ARC_ENABLED } from '../arc.const'
import { toBridgeChainInfo } from '../bridgeChainInfo'

export class RelayBridgeProvider implements HookBridgeProvider<RelayQuote> {
  readonly type = 'HookBridgeProvider' as const
  readonly info: BridgeProviderInfo = {
    name: 'Relay',
    dappId: RELAY_DAPP_ID,
    website: 'https://relay.link',
    type: this.type,
    logoUrl: 'https://relay.link/favicon.ico',
  }
  private readonly api: RelayApi
  private readonly programs = new WeakMap<EvmCall, RelayProgram>()
  private readonly quotes = new WeakSet<RelayQuote>()

  constructor(private readonly options: RelayProviderOptions = {}) {
    this.api = new RelayApi(options.apiUrl)
  }

  private get enabled(): boolean {
    return this.options.enabled ?? RELAY_ENABLED
  }

  private async chains(): Promise<RelayChain[]> {
    if (!this.enabled || !this.options.trustedTokens) return []
    return (await this.api.getChains().catch(() => [])).filter(
      (chain) => RELAY_CHAINS[chain.id] && (chain.id !== 5042 || ARC_ENABLED),
    )
  }

  async getNetworks(): Promise<ChainInfo[]> {
    return (await this.chains()).map((chain) => toBridgeChainInfo(chain.id))
  }

  private async trustedTokens(): Promise<TokenInfo[]> {
    const clock: { timer?: ReturnType<typeof setTimeout> } = {}
    const timeout = new Promise<TokenInfo[]>((resolve) => {
      clock.timer = setTimeout(() => resolve([]), 3_000)
    })
    try {
      // The app shares one in-flight list fetch. A slow list must not exhaust the SDK's 10s provider-union budget.
      return await Promise.race([this.options.trustedTokens?.() ?? [], timeout])
    } finally {
      clearTimeout(clock.timer)
    }
  }

  async getBuyTokens({ buyChainId, sellChainId }: BuyTokensParams): Promise<GetProviderBuyTokens> {
    if (!this.enabled) return { tokens: [], isRouteAvailable: false }
    if (sellChainId !== undefined && !this.options.sourceChainIds?.has(sellChainId))
      return { tokens: [], isRouteAvailable: false }
    const chains = await this.chains()
    const destination = chains.find((chain) => chain.id === buyChainId)
    if (!destination) return { tokens: [], isRouteAvailable: false }
    const source = chains.find((chain) => chain.id === sellChainId)
    const trusted = await this.trustedTokens()
    const sourceAssets = new Set(source ? relayTokens(source, trusted, true).map((token) => token.asset) : [])
    const tokens = destination
      ? relayTokens(destination, trusted).filter((token) => sellChainId === undefined || sourceAssets.has(token.asset))
      : []
    return { tokens, isRouteAvailable: tokens.length > 0 && sellChainId !== buyChainId }
  }

  async getIntermediateTokens(request: QuoteBridgeRequest): Promise<TokenInfo[]> {
    if (!this.enabled || !this.options.sourceChainIds?.has(request.sellTokenChainId)) return []
    const [chains, trusted] = await Promise.all([this.chains(), this.trustedTokens()])
    const source = chains.find((chain) => chain.id === request.sellTokenChainId)
    const destination = chains.find((chain) => chain.id === request.buyTokenChainId)
    if (!source || !destination) return []
    const buy = relayTokens(destination, trusted).find(
      (token) => token.address && sameToken(token, request.buyTokenAddress),
    )
    return buy && buy.decimals === request.buyTokenDecimals
      ? relayTokens(source, trusted, true).filter((token) => token.asset === buy.asset)
      : []
  }

  async getQuote(request: QuoteBridgeRequest): Promise<RelayQuote> {
    const candidates = await this.getIntermediateTokens(request)
    relayAssert(
      candidates.some(
        (token) => sameToken(token, request.sellTokenAddress) && token.decimals === request.sellTokenDecimals,
      ),
    )
    const shed = new CowShedSdk(getGlobalAdapter()).getCowShedAccount(request.sellTokenChainId, request.account)
    const quote = await relayQuote(this.api, request, shed)
    this.quotes.add(quote)
    return quote
  }

  async getUnsignedBridgeCall(request: QuoteBridgeRequest, quote: RelayQuote): Promise<EvmCall> {
    relayAssert(this.quotes.has(quote) && sameRelayRequest(request, quote.request))
    verifyRelayQuote(quote.relay, request, Math.floor(Date.now() / 1000))
    const shed = new CowShedSdk(getGlobalAdapter()).getCowShedAccount(request.sellTokenChainId, request.account)
    const { call, terms } = relayProgram({ owner: request.account, shed, request, quote })
    this.programs.set(call, { call: { ...call }, terms })
    return call
  }

  async getSignedHook(...args: Parameters<HookBridgeProvider<RelayQuote>['getSignedHook']>): Promise<BridgeHook> {
    const program = this.programs.get(args[1])
    relayAssert(
      program &&
        areAddressesEqual(program.call.to, args[1].to) &&
        program.call.data === args[1].data &&
        program.call.value === args[1].value,
    )
    const { terms } = program
    relayAssert(terms && args[0] === terms.request.sellTokenChainId && this.options.signHook)
    return this.options.signHook(terms, ...args)
  }

  async getGasLimitEstimationForHook(): Promise<number> {
    return 1_200_000
  }
  getStatus(
    ...[id]: Parameters<HookBridgeProvider<RelayQuote>['getStatus']>
  ): ReturnType<HookBridgeProvider<RelayQuote>['getStatus']> {
    return relayStatus(this.api, id)
  }
  getBridgingParams(
    ...args: Parameters<HookBridgeProvider<RelayQuote>['getBridgingParams']>
  ): ReturnType<HookBridgeProvider<RelayQuote>['getBridgingParams']> {
    return relayBridgingParams(this.getStatus.bind(this), ...args)
  }
  getExplorerUrl(id: string): string {
    return `https://relay.link/transaction/${encodeURIComponent(id)}`
  }
  async getCancelBridgingTx(): Promise<EvmCall> {
    throw new Error('Relay deposits cannot be cancelled from Ophis')
  }
  async getRefundBridgingTx(): Promise<EvmCall> {
    throw new Error('Refunds are managed by Relay; open the Relay transaction for recovery')
  }
  async decodeBridgeHook(): Promise<BridgeDeposit> {
    throw new Error('Relay deposits are decoded from order metadata and confirmed deposit logs')
  }
}

function sameToken(token: TokenInfo, address: string): boolean {
  return areAddressesEqual(token.address, address)
}
