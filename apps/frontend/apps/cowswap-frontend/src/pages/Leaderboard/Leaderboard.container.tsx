/**
 * LeaderboardPage — public rebate leaderboard (Phase C, 2026-06-11).
 *
 * Jumper "Classement" style: ranked wallet rows by 30-day volume. Consumes
 * GET rebates.ophis.fi/leaderboard (already sorted by volume30dUsd desc and
 * CORS-allowed for swap.ophis.fi). PUBLIC: works with no wallet connected.
 * When a wallet is connected, its own row is highlighted in place, and a
 * pinned summary row at the top shows its position (Jumper's "your rank" row).
 *
 * The RANK shown is the wallet's leaderboard position; the tier column is the
 * volume-keyed rebate Tier (apps/rebate-indexer/src/tiers.ts). No partner /
 * friends-and-family tier is exposed here.
 *
 * AGENTS.md compliance: named export (no default), page in *.container.tsx,
 * barrel re-export in index.ts.
 */
import { ReactNode, useEffect, useMemo, useState } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { Callout, PageShell, Section, Table, Tbody, Td, Th, Thead, Tr } from 'ophis/ds'

import { type LeaderboardEntry, getLeaderboard, getRankStatus } from 'modules/affiliate'

import { Num, SelfTr, YouTag } from './Leaderboard.styled'

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function titleCase(name: string): string {
  return name.length ? name[0]!.toUpperCase() + name.slice(1) : name
}

function tierLabel(name: string): string {
  return name === 'none' ? 'Unranked' : titleCase(name)
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

interface RowProps {
  entry: LeaderboardEntry
  isSelf: boolean
}

function LeaderboardRow({ entry, isSelf }: RowProps): ReactNode {
  const RowEl = isSelf ? SelfTr : Tr
  return (
    <RowEl>
      <Td>
        <Num>{entry.rank}</Num>
      </Td>
      <Td>
        {/* The API already truncates wallets for privacy. truncateAddress is
            idempotent on the 0xXXXX...XXXX form, so re-applying it here is
            defense-in-depth: it preserves the privacy guarantee during deploy
            skew (frontend live before the indexer, or an older REBATES_API that
            still returns full addresses). */}
        <Num>{truncateAddress(entry.wallet)}</Num>
        {isSelf && <YouTag>you</YouTag>}
      </Td>
      <Td>{tierLabel(entry.tier)}</Td>
      <Td>
        <Num>{formatUsd(entry.volume30dUsd)}</Num>
      </Td>
      <Td>
        <Num>{entry.affiliateCount}</Num>
      </Td>
      <Td>
        <Num>{formatUsd(entry.referredVolumeUsd)}</Num>
      </Td>
    </RowEl>
  )
}

export function LeaderboardPage(): ReactNode {
  const { account } = useWalletInfo()

  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // The connected wallet's leaderboard RANK (1-based position) from /rank/:wallet.
  // The public /leaderboard truncates addresses for privacy and truncated forms
  // can collide across distinct addresses, so the connected row is identified by
  // its unique rank, never by the (non-unique) truncated wallet string.
  const [selfPosition, setSelfPosition] = useState<number | null>(null)

  useEffect(() => {
    const signal = { cancelled: false }
    setLoading(true)
    setLoadError(false)
    getLeaderboard(100)
      .then((res) => {
        if (!signal.cancelled) setEntries(res.entries)
      })
      .catch(() => {
        if (!signal.cancelled) setLoadError(true)
      })
      .finally(() => {
        if (!signal.cancelled) setLoading(false)
      })
    return () => {
      signal.cancelled = true
    }
  }, [])

  // Fetch the connected wallet's rank from /rank/:wallet. position is the unique
  // 1-based leaderboard rank (same volume-desc, wallet-asc ordering as
  // /leaderboard), or null when the wallet has no indexed volume.
  useEffect(() => {
    if (!account) {
      setSelfPosition(null)
      return
    }
    const signal = { cancelled: false }
    setSelfPosition(null) // clear any stale rank when the account changes
    getRankStatus(account)
      .then((res) => {
        if (!signal.cancelled) setSelfPosition(res.position)
      })
      .catch(() => {
        // 404 (no indexed volume) or a transient error: treat as unranked.
        if (!signal.cancelled) setSelfPosition(null)
      })
    return () => {
      signal.cancelled = true
    }
  }, [account])

  // The connected wallet's own entry, matched by unique rank (not the truncated
  // wallet string, which can collide across distinct addresses).
  const selfEntry = useMemo(
    () => (selfPosition !== null && entries ? entries.find((e) => e.rank === selfPosition) : undefined),
    [selfPosition, entries],
  )

  return (
    <PageShell
      width="wide"
      eyebrow="Leaderboard"
      title="Top traders by 30-day volume."
      lede="Ranked by rolling 30-day volume on Ophis. Volume sets your rebate tier and your share of the monthly WETH rebate pool."
    >
      {selfEntry && (
        <Section id="your-rank" title="Your rank">
          <Table caption="Your leaderboard position">
            <Thead>
              <Tr>
                <Th>Rank</Th>
                <Th>Wallet</Th>
                <Th>Tier</Th>
                <Th>30d volume</Th>
                <Th>Affiliates</Th>
                <Th>Referred volume</Th>
              </Tr>
            </Thead>
            <Tbody>
              <LeaderboardRow entry={selfEntry} isSelf />
            </Tbody>
          </Table>
        </Section>
      )}

      <Section id="leaderboard" title="Leaderboard">
        {loading ? (
          <p>Loading the leaderboard...</p>
        ) : loadError ? (
          <Callout tone="warning" title="Could not load the leaderboard">
            <p>The rebate service did not respond. Refresh the page to try again.</p>
          </Callout>
        ) : !entries || entries.length === 0 ? (
          <Callout tone="info" title="No ranked traders yet">
            <p>Once wallets start routing volume, the top traders will appear here.</p>
          </Callout>
        ) : (
          <>
            {account && !selfEntry && (
              <p>
                Your wallet isn&apos;t in the top {entries.length} yet. Route more volume to climb
                the board.
              </p>
            )}
            <Table caption="Top traders by 30-day volume">
              <Thead>
                <Tr>
                  <Th>Rank</Th>
                  <Th>Wallet</Th>
                  <Th>Tier</Th>
                  <Th>30d volume</Th>
                  <Th>Affiliates</Th>
                  <Th>Referred volume</Th>
                </Tr>
              </Thead>
              <Tbody>
                {entries.map((entry) => (
                  <LeaderboardRow
                    key={entry.rank}
                    entry={entry}
                    isSelf={selfPosition !== null && entry.rank === selfPosition}
                  />
                ))}
              </Tbody>
            </Table>
          </>
        )}
      </Section>
    </PageShell>
  )
}
