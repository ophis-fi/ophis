import { areAddressesEqual, EnrichedOrder, isCoWSettlementContract, SupportedChainId } from '@cowprotocol/cow-sdk'
import { HookBridgeProvider } from '@cowprotocol/sdk-bridging'
import { Interface } from '@ethersproject/abi'

import { RELAY_DAPP_ID, RELAY_DEPOSIT, relayDepository } from './relay.constants'
import { RelayQuote } from './relay.types'
import { relayAssert, verifyRelayQuote } from './relay.validation'

import { getEthFlowContractAddresses } from '../common'
import { getRpcProvider } from '../networks'

const LOGS = new Interface([
  ...RELAY_DEPOSIT.fragments,
  'event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
type Provider = HookBridgeProvider<RelayQuote>

function relayOrderOwner(chainId: number, order: EnrichedOrder): string | undefined {
  const isEthFlowOwner = [
    getEthFlowContractAddresses('prod', chainId as SupportedChainId),
    getEthFlowContractAddresses('staging', chainId as SupportedChainId),
  ].some((address) => areAddressesEqual(address, order.owner))
  return isEthFlowOwner ? order.onchainOrderData?.sender : order.owner
}

function readRelayBridge(
  chainId: number,
  order: EnrichedOrder,
): { request: RelayQuote['request']; quote: RelayQuote['relay']; shed: string } | null {
  const bridging = JSON.parse(order.fullAppData || '{}').metadata?.bridging
  if (bridging?.providerId !== RELAY_DAPP_ID || !bridging.quoteBody) return null
  const saved = JSON.parse(bridging.quoteBody) as Pick<RelayQuote, 'request' | 'relay'>
  const request = { ...saved.request, amount: BigInt(saved.request.amount) }
  const quote = verifyRelayQuote(saved.relay, request, 0)
  const shed = order.receiver
  const owner = relayOrderOwner(chainId, order)
  relayAssert(shed && request.sellTokenChainId === chainId && areAddressesEqual(request.account, owner))
  relayAssert(areAddressesEqual(request.sellTokenAddress, order.buyToken))
  relayAssert(
    String(request.buyTokenChainId) === String(bridging.destinationChainId) &&
      areAddressesEqual(request.buyTokenAddress, bridging.destinationTokenAddress),
  )
  return { request, quote, shed }
}

export async function relayBridgingParams(
  getStatus: Provider['getStatus'],
  ...[chainId, order, txHash, settlementOverride]: Parameters<Provider['getBridgingParams']>
): ReturnType<Provider['getBridgingParams']> {
  const saved = readRelayBridge(chainId, order)
  if (!saved) return null
  const { request, quote, shed } = saved
  const receipt = await getRpcProvider(chainId as SupportedChainId).getTransactionReceipt(txHash)
  if (receipt?.status !== 1) return null
  const logs = receipt.logs.flatMap((log) => {
    try {
      return [{ address: log.address, event: LOGS.parseLog(log) }]
    } catch {
      return []
    }
  })
  const traded = logs.findIndex(
    ({ address, event }) =>
      event.name === 'Trade' &&
      (isCoWSettlementContract(address, chainId as SupportedChainId) ||
        areAddressesEqual(settlementOverride?.[chainId as SupportedChainId], address)) &&
      String(event.args.orderUid).toLowerCase() === order.uid.toLowerCase(),
  )
  const paid = logs.findIndex(
    ({ address, event }, i) =>
      traded >= 0 &&
      i > traded &&
      event.name === 'Transfer' &&
      areAddressesEqual(address, request.sellTokenAddress) &&
      areAddressesEqual(event.args.from, logs[traded].address) &&
      areAddressesEqual(event.args.to, shed) &&
      event.args.value.gt(0),
  )
  if (paid < 0) return null
  const deposited = logs.some(
    ({ address, event }, i) =>
      i > paid &&
      event.name === 'RelayErc20Deposit' &&
      areAddressesEqual(address, relayDepository(chainId)) &&
      areAddressesEqual(event.args.from, shed) &&
      areAddressesEqual(event.args.token, request.sellTokenAddress) &&
      event.args.amount.toBigInt() === request.amount &&
      event.args.id === quote.protocol.v2.orderId &&
      logs
        .slice(paid + 1, i)
        .some(
          (pull) =>
            pull.event.name === 'Transfer' &&
            areAddressesEqual(pull.address, request.sellTokenAddress) &&
            areAddressesEqual(pull.event.args.from, shed) &&
            areAddressesEqual(pull.event.args.to, address) &&
            pull.event.args.value.toBigInt() === request.amount,
        ),
  )
  if (!deposited) return null
  return {
    params: {
      inputTokenAddress: request.sellTokenAddress,
      outputTokenAddress: request.buyTokenAddress,
      inputAmount: request.amount,
      outputAmount: BigInt(quote.details.currencyOut.minimumAmount),
      owner: request.account,
      recipient: request.receiver || request.account,
      sourceChainId: chainId,
      destinationChainId: request.buyTokenChainId,
      bridgingId: quote.requestId,
      quoteTimestamp: null,
      fillDeadline: quote.protocol.v2.orderData.output.deadline,
    },
    status: await getStatus(quote.requestId, chainId as SupportedChainId),
  }
}
