import { useAtomValue } from 'jotai'
import { useCallback } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { correlatedTokensAtom } from 'entities/correlatedTokens'

import { basketWidgetVolumeFeeAtom, resolveVolumeFeeForPair, VolumeFee } from 'modules/volumeFee'

/** Resolves the Volume fee for one leg's own token pair. */
export type ResolveLegPartnerFeeFn = (leg: {
  readonly sellToken: string
  readonly buyToken: string
}) => VolumeFee | undefined

/**
 * Per-leg Volume fee for a basket.
 *
 * The rate is a property of the PAIR, not of the screen: a basket can hold a
 * stable-to-stable leg (reduced rate), a boosted-token leg (reduced rate) and an
 * ordinary leg at the same time. `useVolumeFee()` answers for whatever pair the
 * swap form currently holds, so reusing it across legs charges every leg an
 * unrelated pair's rate. That either undercharges a non-stable leg at 1 bp,
 * which the backend fee floor then rejects at ingress, or overcharges a stable
 * leg at the standard rate.
 *
 * Returns a resolver rather than a value because the caller has the legs and
 * this hook must not re-run per leg. Both the quote fan-out and the appData
 * builder take this same function, so the fee a user is quoted is by
 * construction the fee their order carries.
 *
 * Basket legs are same-chain by definition, so no cross-chain or bridge handling
 * is needed here: `chainId` covers the stablecoin set, the boosted lookup and
 * the Volume-only floor at once.
 */
export function useBasketLegPartnerFee(): ResolveLegPartnerFeeFn {
  const { chainId } = useWalletInfo()
  // basketWidgetVolumeFeeAtom, NOT widgetPartnerFeeAtom: the latter reads the URL
  // trade type, which is null on a dedicated basket route and would drop the fee
  // for every leg. The basket variant pins the widget trade type to SWAP.
  const widgetPartnerFee = useAtomValue(basketWidgetVolumeFeeAtom)
  const correlatedTokensByChain = useAtomValue(correlatedTokensAtom)
  const correlatedTokens = chainId ? correlatedTokensByChain[chainId] : undefined

  return useCallback(
    (leg) =>
      resolveVolumeFeeForPair(
        {
          chainId,
          sellTokenAddress: leg.sellToken,
          buyTokenAddress: leg.buyToken,
        },
        {
          widgetPartnerFee,
          // A basket is never rendered inside a Safe App today, and a Safe App
          // fee is scoped to the Safe's own swap flow. Passing undefined keeps
          // this from silently redirecting basket revenue to a Safe recipient.
          safeAppFee: undefined,
          correlatedTokens,
        },
      ),
    [chainId, widgetPartnerFee, correlatedTokens],
  )
}
