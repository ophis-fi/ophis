import { SupportedChainId } from '@cowprotocol/cow-sdk'

import * as Sentry from '@sentry/react'
import useSWR from 'swr'

import { orderBookApi } from 'cowSdk'

// Ophis fork: on OP mainnet (chain 10) there's no Ophis-branded explorer yet
// (task #99), so until then we resolve the settlement-tx URL for a *fulfilled*
// order via the orderbook trades endpoint. The order owner's address page is
// kept as the fallback when no trade is available (pending / failed / fetch
// error). See `apps/frontend/libs/common-utils/src/explorer.ts`.

const OPHIS_SUPPORTED_CHAINS: ReadonlyArray<number> = [10 /* Optimism mainnet */]
const COW_ORDER_UID_LENGTH = 114 // "0x" + 56 bytes hex

/**
 * Returns the on-chain settlement tx hash for a CoW order when:
 *  - the chainId is an Ophis fork chain (currently: OP mainnet)
 *  - the id looks like a CoW order UID (114 hex chars including `0x`)
 *  - the orderbook reports at least one trade with a non-null `txHash`
 *
 * Returns `null` while loading, on error, or when the order isn't fulfilled.
 * SWR provides caching + dedup so the same orderUid won't be re-fetched.
 */
export function useSettlementTxHash(chainId: number | undefined, orderUid: string | undefined): string | null {
  const enabled =
    !!chainId &&
    OPHIS_SUPPORTED_CHAINS.includes(chainId) &&
    !!orderUid &&
    orderUid.length === COW_ORDER_UID_LENGTH

  const { data } = useSWR(
    enabled ? ['ophis-settlement-tx', chainId, orderUid] : null,
    async ([, _chainId, _orderUid]) => {
      try {
        const trades = await orderBookApi.getTrades(
          { orderUid: _orderUid as string },
          { chainId: _chainId as SupportedChainId },
        )
        // Pick the most recent trade with a non-null txHash. Trades are
        // returned in chronological order so we scan from the end.
        for (let i = trades.length - 1; i >= 0; i--) {
          const tx = trades[i]?.txHash
          if (tx) return tx
        }
        return null
      } catch (err) {
        // Network/API error — fall through to the address-page fallback.
        // Phase 3 audit M (silent-failure): the old behavior swallowed
        // every error silently, so a regressed orderbook OR a real bug
        // (e.g. malformed orderUid making it past the length-114 guard,
        // chainId/orderUid type confusion, CORS misconfig after a CF
        // tunnel change) presented to users as "no settlement link" —
        // visually indistinguishable from a pending order. That mode of
        // failure could persist for days without anyone noticing.
        //
        // Log path: console.warn for local dev visibility + Sentry
        // breadcrumb (NOT captureException) because the catch IS the
        // expected fallback — capturing every miss would blow our error
        // budget. Breadcrumbs attach to the next real captured error so
        // we still get the context if something else trips.
        // eslint-disable-next-line no-console
        console.warn('[useSettlementTxHash] orderbook getTrades failed', {
          chainId: _chainId,
          orderUid: _orderUid,
          error: err,
        })
        Sentry.addBreadcrumb({
          category: 'ophis.settlement',
          level: 'warning',
          message: 'useSettlementTxHash: orderbook getTrades failed',
          data: {
            chainId: _chainId,
            orderUid: _orderUid,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        })
        return null
      }
    },
    {
      // Settlement is monotonic — once observed, the txHash never changes,
      // so we don't need to revalidate aggressively.
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      // But do poll while the order is pending (no tx hash yet). 8s matches
      // the orderbook's typical block-tail.
      refreshInterval: (latest) => (latest ? 0 : 8000),
    },
  )

  return data ?? null
}
