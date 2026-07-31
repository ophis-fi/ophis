import { DecomposedLeg } from './decomposition'

/**
 * Stable per-leg key for the quotes record: the sell/buy SLOT indices. Two
 * different leg sets can share a slot key, so this is NOT enough to detect that
 * a leg's TOKENS changed.
 */
export function legQuoteKey(leg: Pick<DecomposedLeg, 'sellIndex' | 'buyIndex'>): string {
  return `${leg.sellIndex}:${leg.buyIndex}`
}

/**
 * Fan-out invalidation signature for a leg set. Includes the sell and buy TOKEN
 * addresses (lowercased) alongside the slot and amount, so swapping a sell or
 * buy token at the same slot/amount produces a different signature and re-fans
 * the quotes. Omitting the tokens (the pre-fix bug) let a token change reuse the
 * stale quote for the old pair, so placement could sign an unrelated buy amount.
 *
 * Also folds in each leg's RESOLVED fee (`resolveFee`) when supplied: the fee is
 * quoted into the buy amount, so when it changes (correlated-token data loads,
 * the injected-widget fee updates) the signature changes and the caller can
 * treat the prior quotes as stale synchronously, instead of a completed quote
 * reading ready for a render while it was quoted with a now-outdated fee.
 */
export function legsQuoteSignature(
  legs: readonly DecomposedLeg[] | null,
  resolveFee?: (leg: Pick<DecomposedLeg, 'sellToken' | 'buyToken'>) =>
    | { readonly volumeBps: number; readonly recipient: string }
    | undefined,
): string {
  if (!legs) return ''
  return legs
    .map((l) => {
      const fee = resolveFee?.(l)
      const feeSig = fee ? `${fee.volumeBps}:${fee.recipient.toLowerCase()}` : 'nofee'
      return `${legQuoteKey(l)}|${l.sellToken.toLowerCase()}>${l.buyToken.toLowerCase()}@${l.sellAmount}#${feeSig}`
    })
    .join('~')
}
