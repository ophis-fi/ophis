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

import { type LeaderboardEntry, getLeaderboard } from 'modules/affiliate'

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
            idempotent on the 0xXXXX...XXXX form, so re-applying it is
            defense-in-depth against deploy skew (frontend live before the
            indexer, or an older REBATES_API that still returns full addresses). */}
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

  // The loaded leaderboard PLUS the account it was fetched for. Tying the two
  // together means self-marking is honoured only while the loaded data matches
  // the currently-connected account: during an account-change refetch the public
  // list keeps showing (no flicker), but no stale row is marked "you", and a slow
  // or failed refetch can't leave a previous wallet highlighted.
  const [data, setData] = useState<{ entries: LeaderboardEntry[]; account: string | undefined } | null>(null)
  const [loadError, setLoadError] = useState(false)

  // Refetch when the connected account changes: with a wallet connected we pass
  // `self` so the backend marks the own row (isSelf) within the same snapshot.
  // The truncated wallet string is NOT used to identify self (it can collide).
  useEffect(() => {
    const signal = { cancelled: false }
    setLoadError(false)
    getLeaderboard(100, account)
      .then((res) => {
        if (!signal.cancelled) setData({ entries: res.entries, account })
      })
      .catch(() => {
        if (!signal.cancelled) setLoadError(true)
      })
    return () => {
      signal.cancelled = true
    }
  }, [account])

  // Self state is valid only when the loaded data was fetched for the CURRENT
  // account (not a stale snapshot from a previously-connected wallet). The `&&
  // data` guard narrows the type without a non-null assertion (AGENTS.md).
  const selfResolved = !!data && data.account === account
  // Whether this response actually carries backend self-marking. An older
  // rebate-indexer (deploy skew) returns no `isSelf` field at all; in that case
  // we must NOT claim the wallet is absent (every row would lack isSelf).
  const selfMarkingAvailable = !!data && data.entries.some((e) => e.isSelf !== undefined)
  const selfEntry = useMemo(
    () => (selfResolved && data ? data.entries.find((e) => e.isSelf) : undefined),
    [selfResolved, data],
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
        {data === null ? (
          loadError ? (
            <Callout tone="warning" title="Could not load the leaderboard">
              <p>The rebate service did not respond. Refresh the page to try again.</p>
            </Callout>
          ) : (
            <p>Loading the leaderboard...</p>
          )
        ) : data.entries.length === 0 ? (
          <Callout tone="info" title="No ranked traders yet">
            <p>Once wallets start routing volume, the top traders will appear here.</p>
          </Callout>
        ) : (
          <>
            {account && selfResolved && selfMarkingAvailable && !selfEntry && (
              <p>
                Your wallet isn&apos;t in the top {data.entries.length} yet. Route more volume to climb
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
                {data.entries.map((entry) => (
                  <LeaderboardRow
                    key={entry.rank}
                    entry={entry}
                    isSelf={selfResolved && !!entry.isSelf}
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
