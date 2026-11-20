import {
  ACROSS_V5_API,
  ACROSS_V5_DESTINATIONS,
  AcrossV5Quote,
  AcrossV5Request,
  acrossV5Api,
  acrossV5BridgeQuote,
  acrossV5Currency,
  acrossV5FixedAmount,
  acrossV5History,
  acrossV5Program,
  acrossV5Tokens,
  checkAcrossV5Deposit,
  getAcrossV5BuyTokens,
  getAcrossV5Status,
} from '@cowprotocol/common-const'
import { areAddressesEqual, EvmCall, getGlobalAdapter, OrderKind, TokenInfo } from '@cowprotocol/cow-sdk'
import {
  BridgeProviderQuoteError,
  BridgeQuoteErrors,
  BuyTokensParams,
  HookBridgeProvider,
  QuoteBridgeRequest,
} from '@cowprotocol/sdk-bridging'
import { CowShedSdk } from '@cowprotocol/sdk-cow-shed'
import { fetchTokenList, OPHIS_TOKENS_LIST_SOURCE } from '@cowprotocol/tokens'

import { BRIDGE_QUOTE_ACCOUNT } from 'common/constants/bridgeQuoteAccount'

import { NOT_OWNER, OrdersOf, QUOTE_CHANGED } from './ophisAcrossConstants'
import { rememberHook } from './ophisAcrossPlacedHooks'
import { assertAcrossV5Placeable } from './ophisAcrossPlacement'
import { signedByOwner } from './ophisAcrossSignature'
import { keepTrustedSameAsset } from './ophisAcrossTokenTrust'
import { ACROSS_EXECUTABLE_SOURCE_IDS, OphisAcrossBridgeProvider } from './ophisBridgeProviders'

type Quote = ReturnType<typeof acrossV5BridgeQuote> & { v5: AcrossV5Quote; request: AcrossV5Request }
type Provider = HookBridgeProvider<Quote>
type Program = { call: EvmCall; owner: string; shed: string; quote: Quote }

const unavailable = (): BridgeProviderQuoteError => new BridgeProviderQuoteError(BridgeQuoteErrors.NO_ROUTES, {})

export class OphisAcrossV5Provider implements Provider {
  readonly type = 'HookBridgeProvider' as const
  get info(): Provider['info'] {
    return this.legacy.info
  }
  private readonly quotes = new WeakSet<Quote>()
  private readonly programs = new WeakMap<EvmCall, Program>()
  private trustedList?: Promise<TokenInfo[]>

  constructor(
    private readonly legacy: OphisAcrossBridgeProvider,
    private readonly ordersOf: OrdersOf,
  ) {}

  async getNetworks(): ReturnType<Provider['getNetworks']> {
    const networks = await this.legacy.getNetworks()
    return networks.filter((network) => ACROSS_V5_DESTINATIONS.includes(network.id))
  }

  getBuyTokens(params: BuyTokensParams): ReturnType<Provider['getBuyTokens']> {
    if (params.sellChainId !== undefined && !ACROSS_EXECUTABLE_SOURCE_IDS.has(params.sellChainId)) {
      return Promise.resolve({ tokens: [], isRouteAvailable: false })
    }
    // CoW can acquire the bridge token from a different sell asset on the source chain.
    return getAcrossV5BuyTokens({ ...params, sellTokenAddress: undefined })
  }

  private trustedTokens(): Promise<TokenInfo[]> {
    this.trustedList ??= fetchTokenList({ source: OPHIS_TOKENS_LIST_SOURCE }).then(
      (state) => state.list.tokens,
      (error: unknown) => {
        this.trustedList = undefined
        throw error
      },
    )
    return this.trustedList
  }

  async getIntermediateTokens(request: QuoteBridgeRequest): Promise<TokenInfo[]> {
    if (
      request.kind !== OrderKind.SELL ||
      !ACROSS_EXECUTABLE_SOURCE_IDS.has(request.sellTokenChainId) ||
      !ACROSS_V5_DESTINATIONS.includes(request.buyTokenChainId)
    )
      return []
    const query = new URLSearchParams({
      originChainId: String(request.sellTokenChainId),
      destinationChainId: String(request.buyTokenChainId),
      destinationToken: acrossV5Currency(request.buyTokenAddress),
    })
    const candidates = await acrossV5Tokens(ACROSS_V5_API, query, 'origin')
    return keepTrustedSameAsset(
      () => this.trustedTokens(),
      request,
      candidates.filter((token) => token.chainId === request.sellTokenChainId && BigInt(token.address) !== 0n),
    )
  }

  private requestFor(request: QuoteBridgeRequest): AcrossV5Request {
    const shed = new CowShedSdk(getGlobalAdapter()).getCowShedAccount(request.sellTokenChainId, request.account)
    return {
      originChainId: request.sellTokenChainId,
      destinationChainId: request.buyTokenChainId,
      inputToken: request.sellTokenAddress,
      outputToken: acrossV5Currency(request.buyTokenAddress),
      depositor: shed,
      recipient: request.receiver || request.account,
      amount: acrossV5FixedAmount(request.amount).toString(),
    }
  }

  async getQuote(request: QuoteBridgeRequest): Promise<Quote> {
    if (
      request.kind !== OrderKind.SELL ||
      !ACROSS_EXECUTABLE_SOURCE_IDS.has(request.sellTokenChainId) ||
      !ACROSS_V5_DESTINATIONS.includes(request.buyTokenChainId) ||
      request.sellTokenDecimals !== request.buyTokenDecimals ||
      !(await keepTrustedSameAsset(() => this.trustedTokens(), request, [{ address: request.sellTokenAddress }])).length
    ) {
      throw unavailable()
    }
    const input = this.requestFor(request)
    const v5 = (await acrossV5Api(ACROSS_V5_API, 'quote', input)) as AcrossV5Quote
    checkAcrossV5Deposit(v5, input)
    const quote = { ...acrossV5BridgeQuote(v5, request.amount, input.recipient), v5, request: input }
    this.quotes.add(quote)
    return quote
  }

  async getUnsignedBridgeCall(request: QuoteBridgeRequest, quote: Quote): Promise<EvmCall> {
    const input = this.requestFor(request)
    if (!this.quotes.has(quote) || JSON.stringify(input) !== JSON.stringify(quote.request))
      throw new Error(QUOTE_CHANGED)
    checkAcrossV5Deposit(quote.v5, input)
    const call = acrossV5Program(input, quote.v5.orderId, request.account)
    this.programs.set(call, { call: { ...call }, owner: request.account, shed: input.depositor, quote })
    return call
  }

  async getSignedHook(
    ...[chainId, call, nonce, deadline, gasLimit, signer]: Parameters<Provider['getSignedHook']>
  ): ReturnType<Provider['getSignedHook']> {
    const program = this.programs.get(call)
    assertProgram(program, call, chainId)
    const { owner, shed } = program
    const adapter = getGlobalAdapter()
    const signerAddress = await (signer ? adapter.createSigner(signer) : adapter.signer).getAddress()
    const placing = !areAddressesEqual(signerAddress, BRIDGE_QUOTE_ACCOUNT)
    if (placing) {
      if (!areAddressesEqual(signerAddress, owner)) throw new Error(NOT_OWNER)
      await assertAcrossV5Placeable(program, chainId, deadline, this.ordersOf)
    }
    const calls = [
      { target: call.to, callData: call.data, value: call.value, allowFailure: false, isDelegateCall: true },
    ]
    const result = await new CowShedSdk(adapter).signCalls({
      calls,
      chainId,
      signer,
      nonce,
      deadline,
      gasLimit: BigInt(gasLimit),
    })
    if (
      placing &&
      (!areAddressesEqual(result.cowShedAccount, shed) ||
        !(await signedByOwner(chainId, program, calls, nonce, deadline, result.signedMulticall.data)))
    ) {
      throw new Error(NOT_OWNER)
    }
    if (placing) rememberHook(owner, { chainId, nonce: nonce.toLowerCase(), deadline: String(deadline) })
    return {
      recipient: result.cowShedAccount,
      postHook: {
        target: result.signedMulticall.to,
        callData: result.signedMulticall.data,
        gasLimit: String(result.gasLimit),
        dappId: this.info.dappId,
      },
    }
  }

  async getGasLimitEstimationForHook(): Promise<number> {
    return 800_000
  }

  getStatus(...args: Parameters<Provider['getStatus']>): ReturnType<Provider['getStatus']> {
    return /^\d+$/.test(args[0]) ? this.legacy.getStatus(...args) : getAcrossV5Status(args[0])
  }

  getBridgingParams(...args: Parameters<Provider['getBridgingParams']>): ReturnType<Provider['getBridgingParams']> {
    return acrossV5History(this.legacy.getBridgingParams.bind(this.legacy), ...args)
  }

  getExplorerUrl(id: string): string {
    return this.legacy.getExplorerUrl(id)
  }
  getCancelBridgingTx(id: string): ReturnType<Provider['getCancelBridgingTx']> {
    return this.legacy.getCancelBridgingTx(id)
  }
  getRefundBridgingTx(id: string): ReturnType<Provider['getRefundBridgingTx']> {
    return this.legacy.getRefundBridgingTx(id)
  }
  decodeBridgeHook(hook: Parameters<Provider['decodeBridgeHook']>[0]): ReturnType<Provider['decodeBridgeHook']> {
    return this.legacy.decodeBridgeHook(hook)
  }
}

function assertProgram(program: Program | undefined, call: EvmCall, chainId: number): asserts program is Program {
  if (
    !program ||
    call.to !== program.call.to ||
    call.data !== program.call.data ||
    call.value !== program.call.value ||
    chainId !== program.quote.request.originChainId
  )
    throw new Error(QUOTE_CHANGED)
}
