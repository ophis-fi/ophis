import { isAnyOf } from '@reduxjs/toolkit'
import { Middleware } from 'redux'

import { enrollOphisTrader } from 'common/utils/enrollOphisTrader'

import { AppState } from '../../index'
import * as OrderActions from '../actions'

/**
 * Ophis rebate enrollment on swap (2026-06-25).
 *
 * The rebate indexer is OWNER-SCOPED: it only fetches a wallet's Ophis trades
 * after that wallet is registered in `tracked_wallets`, which happens server-side
 * via `GET rebates.ophis.fi/tier/:wallet`. Until now that call only fired when a
 * user explicitly opted in on the TierChip — a deliberate GDPR purpose-limitation
 * gate that stops us from tracking every wallet that merely CONNECTS (see
 * useRebatesOptIn.ts). The side effect: a wallet that connected, swapped, and
 * never opened the tier UI was never enrolled, so its real Ophis trades went
 * un-indexed and the trader saw no volume / no rebate.
 *
 * Fix: enroll the trading wallet at the moment it PLACES an order. That is the
 * lawful-basis-clean trigger — the wallet is transacting through Ophis and its
 * address is already public on-chain in the settled order's appData — so this
 * does NOT re-introduce the connect-time tracking the opt-in gate prevents.
 *
 * `addPendingOrder` covers market, limit, Safe and eth-flow orders. TWAP
 * enrolls explicitly from its creation flow. We enroll `order.owner`, the
 * trader for every standard order — an EOA for swaps/limit, the Safe for
 * smart-contract wallets. For eth-flow (native-ETH sells) `owner` is the eth-flow
 * CONTRACT rather than the trader; that address is simply re-enrolled (idempotent,
 * and it is already tracked), while the actual eth-flow trader is attributed by
 * the on-chain settle() decoder, not this middleware.
 *
 * Each submission renews server-side enrollment; only in-flight calls are deduplicated.
 */
const isPendingOrderAction = isAnyOf(OrderActions.addPendingOrder)

export const ophisEnrollMiddleware = (() => (next) => (action) => {
  if (isPendingOrderAction(action)) {
    // Enrollment is a best-effort side effect; it must NEVER break order
    // dispatch, so any failure is swallowed and `next(action)` still runs.
    try {
      void enrollOphisTrader(action.payload.order.owner)
    } catch {
      /* noop */
    }
  }
  return next(action)
}) satisfies Middleware<Record<string, unknown>, AppState>
