import { useCallback } from 'react'

import { setRebatesOptIn } from '../hooks/useRebatesOptIn'
import { useTier } from '../hooks/useTier'
import styles from './TierChip.module.css'

interface Props {
  wallet?: `0x${string}`
}

// Phase 3 audit M (2026-05-19): until the user opts in, NO call is made
// to rebates.ophis.fi. Instead we render a small ghost-style CTA that
// invites them to enable the feature. Clicking it persists the opt-in
// and the chip immediately switches to the live-data path on next render.
export function TierChip({ wallet }: Props) {
  const { data, loading, optedIn } = useTier(wallet)

  const handleOptIn = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setRebatesOptIn(true)
  }, [])

  if (!wallet) return null

  if (!optedIn) {
    return (
      <button
        type="button"
        className={`${styles.chip} ${styles.optIn}`}
        onClick={handleOptIn}
        aria-label="Enable rebate tier display (sends your wallet address to rebates.ophis.fi)"
        title="Show your rebate tier. Sends your wallet to rebates.ophis.fi."
      >
        <span className={styles.tierName}>Rebates</span>
        <span className={styles.divider}>▸</span>
        <span className={styles.volume}>Enable</span>
      </button>
    )
  }

  if (loading || !data) return null

  const tier = data.tier.name
  const usd = data.volume_30d_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })
  const next = data.next_tier
  const remaining = next ? data.usd_to_next_tier.toLocaleString(undefined, { maximumFractionDigits: 0 }) : null

  return (
    <a
      className={`${styles.chip} ${styles[tier]}`}
      href={`https://rebates.ophis.fi/tier/${encodeURIComponent(wallet.toLowerCase())}`}
      target="_blank"
      rel="noreferrer"
    >
      <span className={styles.tierName}>{tier}</span>
      <span className={styles.divider}>•</span>
      <span className={styles.volume}>30d: ${usd}</span>
      {next && remaining && (
        <>
          <span className={styles.divider}>•</span>
          <span className={styles.nextTier}>${remaining} to {next.name}</span>
        </>
      )}
    </a>
  )
}
