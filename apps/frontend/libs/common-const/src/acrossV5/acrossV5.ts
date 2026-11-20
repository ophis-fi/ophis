import {
  areAddressesEqual,
  EvmCall,
  getGlobalAdapter,
  isCoWSettlementContract,
  SupportedChainId,
  TokenInfo,
} from '@cowprotocol/cow-sdk'
import {
  AcrossBridgeProvider,
  BridgeStatus,
  BridgeStatusResult,
  BuyTokensParams,
  GetProviderBuyTokens,
} from '@cowprotocol/sdk-bridging'
import { createWeirollContract, createWeirollDelegateCall, WeirollCommandFlags } from '@cowprotocol/sdk-weiroll'
import { Interface } from '@ethersproject/abi'

import {
  ACROSS_V5_ADAPTER,
  ACROSS_V5_DESTINATIONS,
  ACROSS_V5_STORE,
  ACROSS_V5_STORED,
  AcrossV5Request,
  AcrossV5Status,
  acrossOrderId,
} from '../../../../../../functions/_shared/acrossV5'
import {
  acrossV5Api,
  acrossV5Tokens,
  readAcrossV5Order,
  type AcrossV5Order,
} from '../../../../../../functions/_shared/acrossV5Client'
import { NATIVE_CURRENCY_ADDRESS } from '../nativeAndWrappedTokens'
import { getRpcProvider } from '../networks'

export {
  ACROSS_V5_ADAPTER,
  ACROSS_V5_DEADLINE_MARGIN,
  ACROSS_V5_DESTINATIONS,
  ACROSS_V5_STORE,
  acrossV5FixedAmount,
  checkAcrossV5Deposit,
} from '../../../../../../functions/_shared/acrossV5'
export {
  acrossV5Api,
  acrossV5BridgeQuote,
  acrossV5Tokens,
  readAcrossV5Order,
} from '../../../../../../functions/_shared/acrossV5Client'
export type { AcrossV5Quote, AcrossV5Request } from '../../../../../../functions/_shared/acrossV5'

export const ACROSS_V5_API =
  typeof location !== 'undefined' &&
  (location.hostname === 'swap.ophis.fi' || /(^|\.)greg-etm\.pages\.dev$/.test(location.hostname))
    ? '/api/across'
    : 'https://swap.ophis.fi/api/across'

export const acrossV5Currency = (address: string): string =>
  areAddressesEqual(address, NATIVE_CURRENCY_ADDRESS) ? '0x0000000000000000000000000000000000000000' : address

const LOGS = new Interface([
  ACROSS_V5_STORED,
  'event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])

export async function getAcrossV5BuyTokens({
  buyChainId,
  sellChainId,
  sellTokenAddress,
}: BuyTokensParams): Promise<GetProviderBuyTokens> {
  if (!ACROSS_V5_DESTINATIONS.includes(buyChainId) || sellChainId === (buyChainId as number)) {
    return { tokens: [], isRouteAvailable: false }
  }
  const query = new URLSearchParams({ destinationChainId: String(buyChainId) })
  if (sellChainId !== undefined) {
    query.set('originChainId', String(sellChainId))
    if (sellTokenAddress) query.set('originToken', acrossV5Currency(sellTokenAddress))
  }
  const tokens: TokenInfo[] = (await acrossV5Tokens(ACROSS_V5_API, query, 'destination'))
    .filter((token) => token.chainId === buyChainId)
    .map((token) => ({ ...token, address: BigInt(token.address) === 0n ? NATIVE_CURRENCY_ADDRESS : token.address }))
  return { tokens, isRouteAvailable: tokens.length > 0 }
}

type Status = BridgeStatusResult & Pick<AcrossV5Status, 'destination'> & { acrossV5: true }

export function isAcrossV5Status(status?: BridgeStatusResult): boolean {
  return !!status && 'acrossV5' in status && status.acrossV5 === true
}

export async function getAcrossV5Status(orderId: string): Promise<Status> {
  if (!acrossOrderId(orderId)) return { status: BridgeStatus.UNKNOWN, acrossV5: true }
  const data = (await acrossV5Api(ACROSS_V5_API, 'status?orderId=' + orderId)) as Status
  return {
    ...data,
    status: Object.values(BridgeStatus).includes(data?.status) ? data.status : BridgeStatus.UNKNOWN,
    acrossV5: true,
  }
}

type AcrossHistory = AcrossBridgeProvider['getBridgingParams']

export async function acrossV5History(
  legacy: AcrossHistory,
  ...args: Parameters<AcrossHistory>
): ReturnType<AcrossHistory> {
  const [chainId, order, txHash] = args
  const bridging = acrossMetadata(order.fullAppData)
  if (bridging === null) return null
  const saved = readAcrossV5Order(bridging.quoteBody)
  if (!saved) return legacy(...args)
  const { receiver: shed, buyToken } = order
  const { destinationTokenAddress, destinationChainId } = bridging
  if (!shed || !destinationTokenAddress || !destinationChainId) return null
  if (!(await hasV5Deposit(args, saved, shed))) return null

  const status: Status = await getAcrossV5Status(saved.orderId).catch(() => ({
    status: BridgeStatus.IN_PROGRESS,
    acrossV5: true,
  }))
  const outputAmount = deliveredAmount(status, saved, Number(destinationChainId), destinationTokenAddress)
  if (status.status === BridgeStatus.EXECUTED && outputAmount === undefined) status.status = BridgeStatus.UNKNOWN
  return {
    params: {
      inputTokenAddress: buyToken,
      outputTokenAddress: destinationTokenAddress,
      inputAmount: BigInt(saved.amount),
      outputAmount: BigInt(outputAmount ?? saved.minimumOutput),
      owner: shed,
      recipient: saved.recipient,
      sourceChainId: chainId,
      destinationChainId: Number(destinationChainId),
      bridgingId: saved.orderId,
      quoteTimestamp: null,
      fillDeadline: saved.originValidUntil,
    },
    status: { ...status, depositTxHash: txHash },
  }
}

type BridgingMetadata = { quoteBody?: string; destinationTokenAddress?: string; destinationChainId?: string }

function acrossMetadata(appData: string | null | undefined): BridgingMetadata | null {
  try {
    return JSON.parse(appData ?? '{}')?.metadata?.bridging ?? {}
  } catch {
    return null
  }
}

function deliveredAmount(status: Status, saved: AcrossV5Order, chainId: number, token: string): string | undefined {
  const destination = status.destination
  return status.status === BridgeStatus.EXECUTED &&
    destination?.chainId === chainId &&
    areAddressesEqual(destination.token, acrossV5Currency(token)) &&
    areAddressesEqual(destination.recipient, saved.recipient)
    ? destination.amount
    : undefined
}

async function hasV5Deposit(
  [chainId, order, txHash, settlementOverride]: Parameters<AcrossHistory>,
  saved: AcrossV5Order,
  shed: string,
): Promise<boolean> {
  const provider = getRpcProvider(Number(chainId))
  const receipt = await provider?.getTransactionReceipt(txHash)
  if (receipt?.status !== 1) return false
  const logs = receipt.logs.flatMap(({ address, topics, data }) => {
    try {
      return [{ address, event: LOGS.parseLog({ topics, data }) }]
    } catch {
      return []
    }
  })
  const i = logs.findIndex(
    ({ address, event }) =>
      event.name === 'Trade' &&
      String(event.args.orderUid).toLowerCase() === order.uid.toLowerCase() &&
      (isCoWSettlementContract(address, chainId as SupportedChainId) ||
        areAddressesEqual(address, settlementOverride?.[chainId as SupportedChainId])),
  )
  const transfer = (from: string, to: string, amount?: string): number =>
    logs.findIndex(
      ({ address, event }, j) =>
        j > i &&
        event.name === 'Transfer' &&
        areAddressesEqual(address, order.buyToken) &&
        areAddressesEqual(event.args.from, from) &&
        areAddressesEqual(event.args.to, to) &&
        (amount ? event.args.value.eq(amount) : event.args.value.gte(saved.amount)),
    )
  if (i < 0) return false
  const payout = transfer(logs[i].address, shed)
  const pull = transfer(shed, ACROSS_V5_ADAPTER, saved.amount)
  return payout >= 0 && pull > payout && isStored(logs[pull + 1], saved, order.buyToken)
}

function isStored(
  stored: { address: string; event: ReturnType<Interface['parseLog']> } | undefined,
  saved: AcrossV5Order,
  token: string,
): boolean {
  return (
    !!stored &&
    areAddressesEqual(stored.address, ACROSS_V5_ADAPTER) &&
    stored.event.name === 'PrefundingStored' &&
    String(stored.event.args.witness).toLowerCase() === saved.orderId.toLowerCase() &&
    areAddressesEqual(stored.event.args.token, token) &&
    stored.event.args.amount.eq(saved.amount)
  )
}

const TOKEN_ABI = [
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to,uint256 amount) returns (bool)',
]

export function acrossV5Program(input: AcrossV5Request, orderId: string, owner: string): EvmCall {
  const adapter = getGlobalAdapter()
  const token = createWeirollContract(adapter.getContract(input.inputToken, TOKEN_ABI), WeirollCommandFlags.CALL)
  const balance = createWeirollContract(
    adapter.getContract(input.inputToken, TOKEN_ABI),
    WeirollCommandFlags.STATICCALL,
  )
  const escrow = createWeirollContract(
    adapter.getContract(ACROSS_V5_ADAPTER, [ACROSS_V5_STORE]),
    WeirollCommandFlags.CALL,
  )
  return createWeirollDelegateCall((planner) => {
    planner.add(token.approve(ACROSS_V5_ADAPTER, 0n))
    planner.add(token.approve(ACROSS_V5_ADAPTER, BigInt(input.amount)))
    planner.add(escrow.store(orderId, input.inputToken, BigInt(input.amount)))
    const remainder = planner.add(balance.balanceOf(input.depositor))
    planner.add(token.transfer(owner, remainder))
  })
}
