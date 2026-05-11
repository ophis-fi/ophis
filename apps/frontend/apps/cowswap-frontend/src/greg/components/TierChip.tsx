import { useTier } from '../hooks/useTier'
import styles from './TierChip.module.css'

interface Props {
  wallet?: `0x${string}`
}

export function TierChip({ wallet }: Props) {
  const { data, loading } = useTier(wallet)
  if (!wallet || loading || !data) return null

  const tier = data.tier.name
  const usd = data.volume_30d_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })
  const next = data.next_tier
  const remaining = next ? data.usd_to_next_tier.toLocaleString(undefined, { maximumFractionDigits: 0 }) : null

  return (
    <a
      className={`${styles.chip} ${styles[tier]}`}
      href={`https://rebates.ophis.fi/tier/${wallet.toLowerCase()}`}
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
