/**
 * Total flat Volume bps an order's appData partnerFee charges, across every
 * entry (a host widget's fee stacked with the Ophis 1 bp base). Price-improvement
 * entries are conditional and have no fixed bps, so they are not summed. Returns
 * undefined when there is no partnerFee to read, so callers can fall back to the
 * volumeFee pipeline (which knows only about ONE entry).
 */
export function sumVolumeFeeBps(partnerFee: unknown): number | undefined {
  if (!partnerFee) return undefined
  const entries = Array.isArray(partnerFee) ? partnerFee : [partnerFee]
  let total = 0
  let seen = false
  for (const entry of entries) {
    const bps = (entry as { volumeBps?: unknown } | null)?.volumeBps
    if (typeof bps === 'number' && bps > 0) {
      total += bps
      seen = true
    }
  }
  return seen ? total : undefined
}
