import { areAddressesEqual, COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS, OrderStatus } from '@cowprotocol/cow-sdk'

import { orderBookApi } from 'cowSdk'
import { WBTC_ETHEREUM } from 'entities/cctp'
import { parseAbi, parseEventLogs, type Hex, type TransactionReceipt } from 'viem'

import { type BtcSwapPending } from './btcSwapState'
import { cctpClient } from './cctp.service'
import { cctpToken } from './cctpAssets.const'
import { isCctpFinalized } from './cctpStatus.service'

const settlement = COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[1]
const tradeAbi = parseAbi([
  'event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)',
])

export function btcSwapReceived(pending: BtcSwapPending, receipt: TransactionReceipt): bigint {
  const trades = parseEventLogs({ abi: tradeAbi, logs: receipt.logs }).filter(
    (log) =>
      areAddressesEqual(log.address, settlement) && log.args.orderUid.toLowerCase() === pending.orderUid.toLowerCase(),
  )
  const trade = trades[0]?.args
  if (
    receipt.status !== 'success' ||
    trades.length !== 1 ||
    !trade ||
    !areAddressesEqual(trade.owner, pending.owner) ||
    !areAddressesEqual(trade.sellToken, WBTC_ETHEREUM) ||
    !areAddressesEqual(trade.buyToken, cctpToken(1, 'cirBTC')) ||
    trade.sellAmount !== BigInt(pending.sellAmount) ||
    trade.buyAmount < BigInt(pending.minimumBuyAmount)
  )
    throw new Error('Settlement does not match this WBTC swap. Do not start another swap.')
  return trade.buyAmount
}

export async function getBtcSwapStatus(pending: BtcSwapPending): Promise<{
  amount?: string
  ended?: boolean
  text: string
  settlementHash?: Hex
}> {
  if (pending.settlementHash) return btcSwapSettlement(pending)
  const order = await orderBookApi.getOrder(pending.orderUid, { chainId: 1, env: 'prod' }).catch((error: unknown) => {
    if (
      error &&
      typeof error === 'object' &&
      'response' in error &&
      error.response &&
      typeof error.response === 'object' &&
      'status' in error.response &&
      error.response.status === 404
    )
      return null
    throw error
  })
  if (!order || order.status !== OrderStatus.FULFILLED) {
    if (!(await btcSwapExpired(pending)))
      return { text: 'Waiting for the Ethereum swap. Expiry must be finalized before ending this route.' }
    // An expired order can no longer fill, but cleared settlement storage cannot prove it never filled.
    // Recover any indexed fill first; dismissal stays an explicit user action if its history is unavailable.
    return btcSwapSettlement(pending).catch(() => ({
      ended: true,
      text: 'This order has expired. Its fill could not be verified. Recover using its transaction hash, or end this route. Any cirBTC already received stays in your Ethereum wallet.',
    }))
  }
  if (order && (!areAddressesEqual(order.receiver, pending.owner) || order.partiallyFillable))
    throw new Error('Unexpected swap recipient or partial fill')
  return btcSwapSettlement(pending)
}

async function btcSwapSettlement(
  pending: BtcSwapPending,
): Promise<{ amount?: string; text: string; settlementHash?: Hex }> {
  const hash = pending.settlementHash || (await btcSwapHash(pending.orderUid))
  const receipt = await cctpClient(1).getTransactionReceipt({ hash })
  const amount = btcSwapReceived(pending, receipt).toString()
  if (!(await isCctpFinalized(1, receipt)))
    return { text: 'Swap filled. Waiting for Ethereum finality before bridging.' }
  return {
    amount,
    settlementHash: hash,
    text: 'Swap complete. Your cirBTC is in your Ethereum wallet.',
  }
}

async function btcSwapHash(orderUid: string): Promise<Hex> {
  const trades = await orderBookApi.getTrades({ orderUid }, { chainId: 1, env: 'prod' })
  const hash = trades[0]?.txHash
  if (trades.length !== 1 || !hash || !/^0x[a-fA-F0-9]{64}$/.test(hash))
    throw new Error('Settlement hash unavailable. Paste the Ethereum swap transaction hash to recover.')
  return hash as Hex
}

async function btcSwapExpired(pending: BtcSwapPending): Promise<boolean> {
  if (Date.now() <= pending.validTo * 1000) return false
  const block = await cctpClient(1).getBlock({ blockTag: 'finalized' })
  return block.timestamp > BigInt(pending.validTo)
}

export async function recoverBtcSwap(pending: BtcSwapPending, hash: string): Promise<BtcSwapPending> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error('Enter the Ethereum swap transaction hash')
  const next = { ...pending, settlementHash: hash as Hex }
  if (!(await getBtcSwapStatus(next)).amount) throw new Error('Wait for the Ethereum swap to become final')
  return next
}

export async function finishBtcSwap(pending: BtcSwapPending): Promise<null> {
  if (!(await btcSwapExpired(pending))) throw new Error('This swap is still active')
  return null
}
