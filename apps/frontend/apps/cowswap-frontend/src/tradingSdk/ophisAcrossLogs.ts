import { getRpcProvider } from '@cowprotocol/common-const'
import { areAddressesEqual, isCoWSettlementContract, SupportedChainId } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider } from '@cowprotocol/sdk-bridging'
import { Interface } from '@ethersproject/abi'

import { BRIDGE_LOGS } from './ophisAcrossConstants'

const wordAddress = (word: string): string => `0x${word.slice(-40)}`

// A log decoded as one of BRIDGE_LOGS, or nothing (another event, or an ERC-721 Transfer).
type BridgeLog = { address: string; event: ReturnType<Interface['parseLog']> }
function parseBridgeLog(log: { address: string; topics: string[]; data: string }): BridgeLog[] {
  try {
    return [{ address: log.address, event: BRIDGE_LOGS.parseLog(log) }]
  } catch {
    return []
  }
}

/**
 * Who paid the input of the deposit at `logs[i]`: depositV3 pulls it from its
 * caller, then emits the event, so its pull is the last Transfer of the input
 * token into the SpokePool before it, unless an earlier deposit used it (a WETH
 * deposit paid in native ETH logs no Transfer). Anyone can name a shed as
 * depositor, but only the shed's signed hook can pull a non-zero amount out of
 * it (a zero transfer needs no allowance, so a zero deposit proves nothing).
 */
function pulledFrom(logs: BridgeLog[], i: number): string | undefined {
  const { address: spokePool, event } = logs[i]
  const token = wordAddress(event.args.inputToken)
  const pull = logs
    .slice(0, i)
    .reverse()
    .find(
      (log) =>
        (log.event.name === 'FundsDeposited' && areAddressesEqual(log.address, spokePool)) ||
        (log.event.name === 'Transfer' &&
          areAddressesEqual(log.address, token) &&
          areAddressesEqual(log.event.args.to, spokePool)),
    )
  const paid =
    pull?.event.name === 'Transfer' && event.args.inputAmount.gt(0) && pull.event.args.value.eq(event.args.inputAmount)
  return paid ? pull?.event.args.from : undefined
}

// The bridge the order's appData records (sdk-bridging writes metadata.bridging).
function bridgingOf(fullAppData: string | null | undefined): { chainId: string; token: string } | null {
  try {
    const bridging = JSON.parse(fullAppData ?? '')?.metadata?.bridging
    const { destinationChainId, destinationTokenAddress } = bridging ?? {}
    return typeof destinationTokenAddress === 'string' && destinationChainId !== undefined
      ? { chainId: String(destinationChainId), token: destinationTokenAddress }
      : null
  } catch {
    return null
  }
}

/**
 * Upstream pairs the order with the batch's deposit at the index of the
 * order's trade among ALL the batch's trades: another order's deposit, or
 * none, when the batch settles other trades too. Here the settlement (as
 * upstream knows it) must have traded this order, then paid its output into
 * the shed: a non-zero transfer after the Trade (pre-hooks run before any
 * Trade; a zero transfer needs no allowance). The order's hook runs after that
 * payout, so its deposit is the first after it that pulled its input out of
 * the shed (pulledFrom), to the chain and token the order's appData names.
 */
export async function getBridgingParams(
  getStatus: AcrossBridgeProvider['getStatus'],
  ...[chainId, order, txHash, settlementOverride]: Parameters<AcrossBridgeProvider['getBridgingParams']>
): ReturnType<AcrossBridgeProvider['getBridgingParams']> {
  const { receiver: shed, buyToken, uid } = order
  const bridging = bridgingOf(order.fullAppData)
  if (!shed || !bridging) return null
  const receipt = await getRpcProvider(chainId as SupportedChainId).getTransactionReceipt(txHash)
  if (receipt?.status !== 1) return null

  const logs = receipt.logs.flatMap(parseBridgeLog)
  const settlement = (address: string): boolean =>
    isCoWSettlementContract(address, chainId as SupportedChainId) ||
    areAddressesEqual(settlementOverride?.[chainId as SupportedChainId], address)
  const traded = logs.findIndex(
    ({ address, event }) =>
      event.name === 'Trade' && settlement(address) && String(event.args.orderUid).toLowerCase() === uid.toLowerCase(),
  )
  const payout = logs.findIndex(
    ({ address, event }, i) =>
      traded >= 0 &&
      i > traded &&
      event.name === 'Transfer' &&
      areAddressesEqual(address, buyToken) &&
      areAddressesEqual(event.args.from, logs[traded].address) &&
      areAddressesEqual(event.args.to, shed) &&
      event.args.value.gt(0),
  )
  if (payout < 0) return null
  const own = logs.find(
    ({ event }, i) =>
      i > payout &&
      event.name === 'FundsDeposited' &&
      areAddressesEqual(wordAddress(event.args.depositor), shed) &&
      areAddressesEqual(wordAddress(event.args.inputToken), buyToken) &&
      areAddressesEqual(wordAddress(event.args.outputToken), bridging.token) &&
      event.args.destinationChainId.toString() === bridging.chainId &&
      areAddressesEqual(pulledFrom(logs, i), shed),
  )
  if (!own) return null

  const deposit = own.event.args
  const params = {
    inputTokenAddress: wordAddress(deposit.inputToken),
    outputTokenAddress: wordAddress(deposit.outputToken),
    inputAmount: deposit.inputAmount.toBigInt(),
    outputAmount: deposit.outputAmount.toBigInt(),
    owner: shed,
    quoteTimestamp: deposit.quoteTimestamp,
    fillDeadline: deposit.fillDeadline,
    recipient: wordAddress(deposit.recipient),
    sourceChainId: chainId,
    destinationChainId: deposit.destinationChainId.toNumber(),
    bridgingId: deposit.depositId.toString(),
  }
  return { params, status: await getStatus(params.bridgingId, chainId) }
}
