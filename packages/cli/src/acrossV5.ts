import { getGlobalAdapter, OrderKind } from '@cowprotocol/cow-sdk'
import { BridgeStatus, type HookBridgeProvider, type QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { CowShedSdk } from '@cowprotocol/sdk-cow-shed'
import { createWeirollContract, createWeirollDelegateCall, WeirollCommandFlags } from '@cowprotocol/sdk-weiroll'
import { erc20Abi } from 'viem'
import {
  ACROSS_V5_ADAPTER, ACROSS_V5_DEADLINE_MARGIN, ACROSS_V5_DESTINATIONS, ACROSS_V5_STORE,
  acrossV5FixedAmount, checkAcrossV5Deposit,
  type AcrossV5Quote, type AcrossV5Request,
} from '../../../functions/_shared/acrossV5.ts'
import { acrossV5Api, acrossV5BridgeQuote, acrossV5Tokens } from '../../../functions/_shared/acrossV5Client.ts'
import { ACROSS_EXECUTABLE_SOURCE_IDS, OphisAcrossBridgeProvider } from './across.ts'

const API = 'https://swap.ophis.fi/api/across'
type Quote = ReturnType<typeof acrossV5BridgeQuote> & { v5: AcrossV5Quote; request: AcrossV5Request }
export type AcrossV5Program = Readonly<{ quote: AcrossV5Quote; request: AcrossV5Request }>
type Provider = HookBridgeProvider<Quote>

export async function cliAcrossV5Status(orderId: string): ReturnType<Provider['getStatus']> {
  const data = (await acrossV5Api(API, 'status?orderId=' + encodeURIComponent(orderId))) as Awaited<ReturnType<Provider['getStatus']>>
  return Object.values(BridgeStatus).includes(data?.status) ? data : { status: BridgeStatus.UNKNOWN }
}

export function cliAcrossV5Provider(legacy: OphisAcrossBridgeProvider, onProgram: (program: AcrossV5Program) => void): Provider {
  const programs = new WeakMap<object, AcrossV5Program>()
  function input(request: QuoteBridgeRequest): AcrossV5Request {
    return {
      originChainId: request.sellTokenChainId,
      destinationChainId: request.buyTokenChainId,
      inputToken: request.sellTokenAddress,
      outputToken: request.buyTokenAddress,
      depositor: new CowShedSdk(getGlobalAdapter()).getCowShedAccount(request.sellTokenChainId, request.account),
      recipient: request.receiver || request.account,
      amount: acrossV5FixedAmount(request.amount).toString(),
    }
  }
  const route = (request: QuoteBridgeRequest) => request.kind === OrderKind.SELL &&
    ACROSS_EXECUTABLE_SOURCE_IDS.has(request.sellTokenChainId) && ACROSS_V5_DESTINATIONS.includes(request.buyTokenChainId)
  return {
    type: 'HookBridgeProvider',
    info: legacy.info,
    getNetworks: legacy.getNetworks.bind(legacy),
    async getBuyTokens({ buyChainId, sellChainId }) {
      if (!ACROSS_V5_DESTINATIONS.includes(buyChainId)) return { tokens: [], isRouteAvailable: false }
      const query = new URLSearchParams({ destinationChainId: String(buyChainId) })
      if (sellChainId !== undefined) query.set('originChainId', String(sellChainId))
      const tokens = await acrossV5Tokens(API, query, 'destination')
      return { tokens, isRouteAvailable: tokens.length > 0 }
    },
    async getIntermediateTokens(request) {
      if (!route(request)) return []
      const query = new URLSearchParams({
        originChainId: String(request.sellTokenChainId),
        destinationChainId: String(request.buyTokenChainId),
        destinationToken: request.buyTokenAddress,
      })
      const tokens = await acrossV5Tokens(API, query, 'origin')
      return legacy.keepTrustedSameAsset(request, tokens.filter((token) =>
        token.chainId === request.sellTokenChainId && BigInt(token.address) !== 0n,
      ))
    },
    async getQuote(request) {
      if (!route(request) || request.sellTokenDecimals !== request.buyTokenDecimals ||
          !(await legacy.keepTrustedSameAsset(request, [{ address: request.sellTokenAddress }])).length) {
        throw new Error('Across has no routes for this pair')
      }
      const bridge = input(request)
      const v5 = (await acrossV5Api(API, 'quote', bridge)) as AcrossV5Quote
      checkAcrossV5Deposit(v5, bridge)
      return { ...acrossV5BridgeQuote(v5, request.amount, bridge.recipient), v5, request: bridge }
    },
    async getUnsignedBridgeCall(request, quote) {
      const bridge = input(request)
      if (JSON.stringify(bridge) !== JSON.stringify(quote.request)) throw new Error('Across bridge quote changed')
      checkAcrossV5Deposit(quote.v5, bridge)
      const adapter = getGlobalAdapter()
      const token = createWeirollContract(adapter.getContract(bridge.inputToken, erc20Abi), WeirollCommandFlags.CALL)
      const balance = createWeirollContract(adapter.getContract(bridge.inputToken, erc20Abi), WeirollCommandFlags.STATICCALL)
      const escrow = createWeirollContract(adapter.getContract(ACROSS_V5_ADAPTER, [ACROSS_V5_STORE]), WeirollCommandFlags.CALL)
      const call = createWeirollDelegateCall((planner) => {
        planner.add(token.approve(ACROSS_V5_ADAPTER, 0n))
        planner.add(token.approve(ACROSS_V5_ADAPTER, BigInt(bridge.amount)))
        planner.add(escrow.store(quote.v5.orderId, bridge.inputToken, BigInt(bridge.amount)))
        const remainder = planner.add(balance.balanceOf(bridge.depositor))
        planner.add(token.transfer(request.account, remainder))
      })
      programs.set(call, { quote: quote.v5, request: bridge })
      return call
    },
    async getSignedHook(chainId, call, nonce, deadline, gasLimit, signer) {
      const program = programs.get(call)
      if (!program || program.request.originChainId !== chainId) throw new Error('Across bridge quote changed')
      onProgram(program)
      const calls = [{ target: call.to, callData: call.data, value: call.value, allowFailure: false, isDelegateCall: true }]
      const { signedMulticall, cowShedAccount, gasLimit: gas } = await new CowShedSdk(getGlobalAdapter()).signCalls({
        calls, chainId, signer, nonce, deadline, gasLimit: BigInt(gasLimit),
      })
      return {
        recipient: cowShedAccount,
        postHook: { target: signedMulticall.to, callData: signedMulticall.data, gasLimit: String(gas), dappId: legacy.info.dappId },
      }
    },
    getGasLimitEstimationForHook: async () => 800_000,
    getStatus: (id, chain) => /^\d+$/.test(id) ? legacy.getStatus(id, chain) : cliAcrossV5Status(id),
    getBridgingParams: legacy.getBridgingParams.bind(legacy),
    getExplorerUrl: legacy.getExplorerUrl.bind(legacy),
    getCancelBridgingTx: legacy.getCancelBridgingTx.bind(legacy),
    getRefundBridgingTx: legacy.getRefundBridgingTx.bind(legacy),
    decodeBridgeHook: legacy.decodeBridgeHook.bind(legacy),
  }
}

export function cliAcrossV5Deadline(program: AcrossV5Program): number {
  return program.quote.originValidUntil - ACROSS_V5_DEADLINE_MARGIN
}
