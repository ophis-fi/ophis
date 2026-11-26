import { fetchOphisSolanaOrder, fetchOphisWalletActionReceipt } from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG } from 'entities/solana'

import { balanceEndpoint } from './assets.service'

import type { SavedNativeSolanaOrder, SolanaOrderResult } from '../state/orders.atoms'

export function validAtomicOrder(order: Partial<SavedNativeSolanaOrder>): boolean {
  if (order.executionMode === undefined) return order.walletCosts === undefined
  if (
    order.executionMode !== 'walletAtomic' ||
    !order.creationLifetime ||
    !/^\d{1,20}$/.test(order.creationLifetime.height)
  )
    return false
  const costs = order.walletCosts
  return (
    !costs ||
    [costs.networkFee, costs.orderRent, costs.nativeWrapRent ?? '0'].every(
      (value) => typeof value === 'string' && /^\d{1,20}$/.test(value),
    )
  )
}

async function lookupAtomicFill(order: SavedNativeSolanaOrder): Promise<SolanaOrderResult | undefined> {
  if (!OPHIS_SOLANA_CONFIG) return undefined
  const indexed = await fetchOphisSolanaOrder(OPHIS_SOLANA_CONFIG.api, order.uid).catch(() => undefined)
  if (indexed?.owner === order.owner && indexed.orderPda === order.orderPda && indexed.status === 'fulfilled')
    return indexed
  return undefined
}

export async function checkAtomicReceipt(order: SavedNativeSolanaOrder): Promise<SolanaOrderResult> {
  const rpc = balanceEndpoint(OPHIS_SOLANA_CONFIG)
  const lifetime = order.creationLifetime
  if (!rpc || !lifetime) throw Error('Wallet receipt service unavailable.')
  if (!order.signature) {
    if (Date.now() - lifetime.requestedAt < 90_000) return { status: 'pending' }
    const indexed = await lookupAtomicFill(order)
    if (indexed) return indexed
  }
  const { status } = await fetchOphisWalletActionReceipt(
    rpc,
    order.genesis,
    order.signature,
    BigInt(lifetime.height),
    'confirmed',
  )
  return { status: status === 'confirmed' ? 'fulfilled' : status === 'expired' ? 'unconfirmed' : status }
}

export function orderPollInterval(
  status: SolanaOrderResult['status'] | undefined,
  order: SavedNativeSolanaOrder | undefined,
  pastLifetimeWindow: boolean,
): number | false {
  if (!order) return false
  if (status === 'pending') return order.signature ? 1500 : 5000
  if (status) return status === 'open' ? 4000 : false
  if (!order.signature && !order.creationLifetime) return false
  return pastLifetimeWindow ? 15000 : 4000
}
