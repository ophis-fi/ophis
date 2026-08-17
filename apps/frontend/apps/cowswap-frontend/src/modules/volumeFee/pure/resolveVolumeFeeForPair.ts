import { STABLECOINS } from '@cowprotocol/common-const'
import { areAddressesEqual, getAddressKey } from '@cowprotocol/cow-sdk'

import { isBoostedToken, OPHIS_BOOSTED_VOLUME_BPS } from 'ophis/boostedTokens'
import {
  OPHIS_FLAT_VOLUME_FEE_ENABLED,
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_SOVEREIGN_BASE_FEE_BPS,
  OPHIS_STABLE_VOLUME_BPS,
  isVolumeOnlyChain,
  ophisVolumeOnlyFloorFee,
} from 'ophis/partnerFeeDefault'

import { isCorrelatedTrade } from '../state/isCorrelatedTrade'
import { VolumeFee } from '../types'

import type { CorrelatedTokens } from 'entities/correlatedTokens'

/**
 * The token pair a fee is being resolved for.
 *
 * Addresses are raw; every comparison below normalises through `getAddressKey`,
 * so callers must NOT pre-lowercase (a double normalisation is harmless, but
 * relying on the caller to do it is how casing bugs get in).
 */
export interface VolumeFeePair {
  /** Chain the pair trades on. Drives the stablecoin set and the Volume-only floor. */
  chainId: number
  sellTokenAddress: string
  buyTokenAddress: string
  /**
   * Chain to key the BOOSTED-token lookup on, when it differs from `chainId`.
   *
   * Exists only to preserve swap-path behaviour exactly. `isBoostedTradeAtom`
   * deliberately keys on the TRADE's chain ("the boost must match the actual
   * tokens even if the wallet is momentarily on a different chain") while the
   * stablecoin check keys on the connected WALLET's chain. Those differ only
   * during a chain switch. Omit it and it defaults to `chainId`, which is
   * correct for anything built from a single same-chain pair, e.g. a basket leg.
   */
  boostedChainId?: number
  /**
   * The buy token settles on a DIFFERENT chain than the sell token (a bridge
   * trade). Both reduced rates bail out on this and the pair keeps the standard
   * rate.
   *
   * Not derivable from the addresses here, and it must not be dropped: a bridge
   * trade's buy address is substituted for the bridge INTERMEDIATE token, which
   * lives on the sell chain and can therefore be in this chain's stablecoin or
   * boosted set. Without the flag, selling a boosted token cross-chain would
   * silently pick up the reduced rate, which the swap path never did.
   */
  isCrossChain?: boolean
}

/** Ambient (non-pair) inputs to the fee decision. */
export interface VolumeFeeContext {
  /** A host integrator's configured partnerFee, or the Ophis one under the flat-fee flag. */
  widgetPartnerFee: VolumeFee | undefined
  /**
   * Safe App fee, used only when the flat-fee flag is off. `null` is the
   * safeAppFeeAtom's own "no fee" value and is accepted as-is rather than making
   * every caller normalise it.
   */
  safeAppFee: VolumeFee | null | undefined
  /** Correlated-token lists for `pair.chainId`. Undefined when not loaded yet. */
  correlatedTokens: CorrelatedTokens[] | undefined
}

/** Either side of a same-chain pair is a boosted token (the ALEPH flagship). */
export function isBoostedPair(pair: VolumeFeePair): boolean {
  if (pair.isCrossChain) return false
  const chainId = pair.boostedChainId ?? pair.chainId
  return isBoostedToken(chainId, pair.sellTokenAddress) || isBoostedToken(chainId, pair.buyTokenAddress)
}

/** BOTH sides of a same-chain pair are stablecoins, so the reduced 1 bp applies. */
export function isStableStablePair(pair: VolumeFeePair): boolean {
  if (pair.isCrossChain) return false
  // STABLECOINS is keyed by SupportedChainId; a pair can carry any chain id, so
  // widen the index rather than assert the chain is supported. An unsupported
  // chain simply has no stablecoin set and takes the standard rate.
  const stablecoins = (STABLECOINS as Record<number, Set<string> | undefined>)[pair.chainId]
  if (!stablecoins) return false

  return stablecoins.has(getAddressKey(pair.sellTokenAddress)) && stablecoins.has(getAddressKey(pair.buyTokenAddress))
}

/** The pair is a correlated (like-kind) trade, which is fee-exempt on every chain. */
export function isCorrelatedPair(pair: VolumeFeePair, correlatedTokens: CorrelatedTokens[] | undefined): boolean {
  if (!correlatedTokens) return false

  return isCorrelatedTrade(getAddressKey(pair.sellTokenAddress), getAddressKey(pair.buyTokenAddress), correlatedTokens)
}

function resolveOphisOwnVolumeFee(pair: VolumeFeePair, fee: VolumeFee): VolumeFee {
  if (isVolumeOnlyChain(pair.chainId)) {
    return { ...fee, volumeBps: OPHIS_SOVEREIGN_BASE_FEE_BPS }
  }
  if (isBoostedPair(pair)) return { ...fee, volumeBps: OPHIS_BOOSTED_VOLUME_BPS }
  if (isStableStablePair(pair)) return { ...fee, volumeBps: OPHIS_STABLE_VOLUME_BPS }
  return fee
}

function resolveFlatVolumeFee(pair: VolumeFeePair, widgetPartnerFee: VolumeFee | undefined): VolumeFee | undefined {
  const isOphisOwnFee = widgetPartnerFee && areAddressesEqual(widgetPartnerFee.recipient, OPHIS_PARTNER_FEE_RECIPIENT)
  return isOphisOwnFee ? resolveOphisOwnVolumeFee(pair, widgetPartnerFee) : widgetPartnerFee
}

/**
 * Resolve the Volume fee for ONE token pair.
 *
 * This is the fee decision itself, lifted out of `volumeFeeAtom` so it can be
 * applied to something other than "whatever pair the swap form currently holds".
 * `volumeFeeAtom` composes it for the swap widget; `useBuildBasketLegAppData`
 * and `useBasketQuotes` call it PER LEG.
 *
 * Why per leg matters: the rate is a property of the pair, not of the screen. A
 * basket that sells USDC into WETH and DAI into USDT has one leg at the standard
 * rate and one at the reduced stable rate. Resolving once from the swap form and
 * reusing it charges both legs whatever the unrelated swap pair happened to be,
 * which can undercharge a non-stable leg at 1 bp (the backend floor then rejects
 * it) or overcharge a stable leg at 10 bp.
 *
 * The decision order is load-bearing and mirrors the original atom exactly:
 *
 *   1. Correlated pairs are fee-exempt on EVERY chain, matching CoW, and the
 *      exemption is checked BEFORE the Volume-only floor. The floor raises a
 *      present sub-floor fee; it does not force a fee onto an exempt order.
 *      A host integrator's own partnerFee still overrides the exemption.
 *   2. Under the flat-fee flag, the reduced boosted/stable rates rewrite the bps
 *      but ONLY on Ophis's own fee. An integrator embedding this widget with
 *      their own recipient keeps their configured rate untouched.
 *   3. Boosted beats stable when a pair is both.
 *   4. Flag off, no widget fee: emit the Volume-only chain floor so the
 *      displayed fee and the on-chain appData fee stay in lockstep.
 */
export function resolveVolumeFeeForPair(pair: VolumeFeePair, context: VolumeFeeContext): VolumeFee | undefined {
  const { widgetPartnerFee, safeAppFee, correlatedTokens } = context

  if (!widgetPartnerFee && isCorrelatedPair(pair, correlatedTokens)) {
    return undefined
  }

  if (OPHIS_FLAT_VOLUME_FEE_ENABLED) {
    return resolveFlatVolumeFee(pair, widgetPartnerFee)
  }

  if (!widgetPartnerFee) {
    const reducedRate = isStableStablePair(pair) || isBoostedPair(pair)
    const floorFee = ophisVolumeOnlyFloorFee(pair.chainId, reducedRate)
    if (floorFee) return floorFee
  }

  // Ophis fee is never enabled in widget mode, so the Safe App fee wins here.
  return safeAppFee || widgetPartnerFee || undefined
}
