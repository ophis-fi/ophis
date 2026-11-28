import {
  formatOphisSolanaAmount,
  getOrderIntentDecoder,
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
} from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG } from 'entities/solana'

import { nativeAsset, unknownAsset, walletMint, type SolanaAsset } from './assets.service'

import type { SavedNativeSolanaOrder, SolanaOrderResult } from '../state/orders.atoms'
import type { OphisSolanaOrder, OphisSolanaTrade } from '@ophis/solana-sdk'

export type ReceiptAmounts = Pick<OphisSolanaOrder, 'sellToken' | 'buyToken' | 'sellAmount' | 'buyAmount'>
export type ReceiptStatus = SolanaOrderResult['status'] | 'pending' | 'closed'

export function returnedStorageDeposit(costs: {
  orderRent: string | bigint
  nativeWrapRent?: string | bigint
  solverInputRent?: string | bigint
}): bigint {
  return BigInt(costs.orderRent) + BigInt(costs.nativeWrapRent ?? 0n) + BigInt(costs.solverInputRent ?? 0n)
}

export function savedReceiptStatus(
  order: SavedNativeSolanaOrder,
  data?: SolanaOrderResult,
  trade?: OphisSolanaTrade,
): ReceiptStatus {
  if (trade) return 'fulfilled'
  if (data && data.status !== 'open') return data.status
  if (data && 'payoutConfirmed' in data && data.payoutConfirmed) return 'fulfilled'
  const local = localReceiptStatus(order)
  return local ?? (data ? 'open' : 'pending')
}

function localReceiptStatus(order: SavedNativeSolanaOrder): ReceiptStatus | undefined {
  if (order.walletAction?.status === 'confirmed' && !order.walletAction.reclaim) return 'cancelled'
  if (order.reclaimed) return 'closed'
  return undefined
}

export function receiptSellToken(mint: string, order?: SavedNativeSolanaOrder): string {
  return mint === WRAPPED_SOL_MINT && BigInt(order?.walletCosts?.nativeWrapRent ?? '0') > 0n
    ? SOLANA_NATIVE_ASSET
    : mint
}

export function savedReceiptAmounts(order: SavedNativeSolanaOrder): ReceiptAmounts | undefined {
  try {
    const intent = getOrderIntentDecoder().decode(Uint8Array.from(order.intent))
    return {
      sellToken: intent.sellMint,
      buyToken: intent.buyMint,
      sellAmount: String(intent.sellAmount),
      buyAmount: String(intent.buyAmount),
    }
  } catch {
    return undefined
  }
}

export function receiptAmount(
  amount: string,
  mint: string,
  assets: SolanaAsset[],
): { asset: SolanaAsset; value: string } {
  const id = walletMint(mint)
  const asset = id === 'SOL' ? nativeAsset : (assets.find((item) => item.mint === id) ?? unknownAsset(mint))
  return {
    asset,
    value: asset.decimals === undefined ? amount : formatOphisSolanaAmount(BigInt(amount), asset.decimals),
  }
}

export function receiptTxLink(signature?: string | null): string | undefined {
  if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return undefined
  const chain = OPHIS_SOLANA_CONFIG?.chain
  const url = 'https://explorer.solana.com/tx/' + signature
  if (chain === 'solana:mainnet') return url
  if (chain === 'solana:devnet' || chain === 'solana:testnet') return url + '?cluster=' + chain.slice(7)
  return undefined
}
