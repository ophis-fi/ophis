/**
 * ophisAffiliateApi — NATIVE client for the Ophis rebate-indexer affiliate
 * endpoints (rebates.ophis.fi).
 *
 * Deliberately dependency-light: plain `fetch`, no CoW BFF, no LaunchDarkly,
 * no SWR. The /affiliate + /partner pages and the ref-capture updater call
 * these helpers directly.
 *
 * Signed-message format MUST byte-match the backend, which recovers the
 * signer with viem `recoverMessageAddress` (EIP-191 personal_sign). The
 * frontend signs with ethers v5 `signer.signMessage(message)` (also
 * EIP-191), NOT `_signTypedData` (EIP-712, would not verify).
 */

import { AFFILIATE_API_TIMEOUT_MS } from '../config/affiliateProgram.const'

export const REBATES_API = process.env.REACT_APP_REBATES_API || 'https://rebates.ophis.fi'

/**
 * Abort a request that stalls (e.g. a hung CORS preflight or an unresponsive
 * backend) so the UI fails fast instead of spinning forever. The timeout was
 * defined in config but never wired into a fetch before.
 *
 * `AbortSignal.timeout` is not available on every target in the production
 * browserslist (e.g. iOS Safari 15.x), where calling it would throw before
 * `fetch` is even reached, surfacing as a network failure for partner-dashboard,
 * code-creation, and bind requests. Feature-detect it and fall back to an
 * `AbortController` + `setTimeout` so the request still fires and still times out
 * on those browsers.
 */
function timeoutSignal(): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(AFFILIATE_API_TIMEOUT_MS)
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), AFFILIATE_API_TIMEOUT_MS)
  return controller.signal
}

export type AffiliateKind = 'regular' | 'partner'

/** GET /ref/:code */
export interface RefLookupResponse {
  exists: boolean
  kind?: AffiliateKind
  active?: boolean
}

/** POST /ref/bind */
export interface RefBindResponse {
  bound: boolean
  alreadyBound: boolean
}

/** POST /ref/codes */
export interface RefCodeCreateResponse {
  code: string
  kind: 'regular'
  created: boolean
}

/** GET /affiliate/:wallet (PUBLIC, aggregate only) */
export interface AffiliateStats {
  wallet: string
  kind: AffiliateKind
  rateOfNetFeePct: number
  activeCodes: string[]
  referredCount: number
  /** Referred volume in the current payout cycle (shown to regular affiliates). */
  currentCycleVolumeUsd: number
  /** Lifetime referred volume since each referee bound (shown to partners). */
  lifetimeReferredVolumeUsd: number
}

export interface PartnerReferee {
  wallet: string
  boundAt: string
  lifetimeVolumeUsd: number
}

/** POST /partner (whitelist + signature gated) */
export interface PartnerDashboard extends AffiliateStats {
  referees: PartnerReferee[]
  /**
   * Earnings panel fields, added with a newer rebate-indexer. Optional so the
   * frontend keeps typechecking and degrades gracefully if it deploys before
   * the backend. estimatedCurrentCycleEarningsUsd is a volume-derived estimate
   * (not a settled figure); paidToDate is exact, summed from executed batches.
   */
  estimatedCurrentCycleEarningsUsd?: number
  paidToDateWeth?: number
  paidToDateUsd?: number
  nextPayoutAt?: string
}

/**
 * GET /tier/:wallet (JSON path; the same route serves an HTML tier page for
 * Accept: text/html). The rebate RANK = the volume-keyed tier from
 * apps/rebate-indexer/src/tiers.ts. `nextTier`/`nextThresholdUsd`/`toNextUsd`
 * are null at the top tier (platinum). `position` is the 1-based leaderboard
 * rank by 30-day volume, null if the wallet has no indexed volume.
 */
export interface RankStatus {
  wallet: string
  tier: string
  volume30dUsd: number
  rebatePct: number
  nextTier: string | null
  nextThresholdUsd: number | null
  toNextUsd: number | null
  position: number | null
}

/** One row of GET /leaderboard. `wallet` is the TRUNCATED display address
 *  (0xXXXX...XXXX), not the full address: the public endpoint truncates it so it
 *  cannot be used to enumerate full trader addresses. */
export interface LeaderboardEntry {
  rank: number
  wallet: string
  tier: string
  volume30dUsd: number
  volumeTotalUsd: number
  affiliateCount: number
  referredVolumeUsd: number
  /** True only on the connected wallet's own row, set by the backend when
   *  /leaderboard is queried with `?self=<address>`. The backend matches on the
   *  FULL address within one snapshot (collision-free), so the frontend must
   *  identify itself by this flag, NOT by comparing the truncated `wallet`. */
  isSelf?: boolean
}

/** GET /leaderboard?limit=N (PUBLIC, sorted by volume30dUsd desc) */
export interface LeaderboardResponse {
  updatedAt: string
  total: number
  entries: LeaderboardEntry[]
}

export type AffiliateSignedAction =
  | 'Partner Dashboard access'
  | 'create referral code'
  // Bind is per-code, so the action string carries the code itself. The
  // backend rebuilds `bind referral code <code>` and byte-matches it.
  | `bind referral code ${string}`

export interface SignedRequestBody {
  wallet: string
  issued: number
  signature: string
}

/**
 * Build the EIP-191 message string the backend expects. Address is
 * lowercased and `issued` is whole seconds, both load-bearing for the
 * server-side `recoverMessageAddress` byte match.
 */
export function buildAffiliateSignMessage(action: AffiliateSignedAction, address: string, issuedSec: number): string {
  return `Ophis ${action}\nAddress: ${address.toLowerCase()}\nIssued: ${issuedSec}`
}

export function nowIssuedSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Error carrying the HTTP status so callers can branch on 401/403/409/400.
 */
export class AffiliateApiError extends Error {
  readonly status: number

  constructor(status: number, message?: string) {
    super(message || `affiliate API ${status}`)
    this.name = 'AffiliateApiError'
    this.status = status
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // Preserve the server's `{ error: ... }` reason. parseJson previously
    // discarded it, leaving every failure a bare status with no message, so the
    // UI could only ever show a generic error.
    let message: string | undefined
    try {
      const body: unknown = await res.json()
      if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        message = (body as { error: string }).error
      }
    } catch {
      // Non-JSON error body (e.g. a proxy/CORS error page): leave it undefined.
    }
    throw new AffiliateApiError(res.status, message)
  }
  return (await res.json()) as T
}

export function lookupRefCode(code: string): Promise<RefLookupResponse> {
  return fetch(`${REBATES_API}/ref/${encodeURIComponent(code)}`).then((res) =>
    parseJson<RefLookupResponse>(res),
  )
}

/** GET /xp/:wallet — 1 XP per $1 of the wallet's own lifetime fee-bearing volume. */
export interface WalletXp {
  wallet: string
  xp: number
  lifetimeVolumeUsd: number
  generatedAt: string
}

export function getWalletXp(wallet: string): Promise<WalletXp> {
  return fetch(`${REBATES_API}/xp/${encodeURIComponent(wallet.toLowerCase())}`, {
    signal: timeoutSignal(),
  }).then((res) => parseJson<WalletXp>(res))
}

/**
 * Body for POST /ref/bind. The bind is signature-gated: the referred wallet
 * must prove control of its address by `personal_sign`-ing
 * `Ophis bind referral code <code>\nAddress: <referredWallet lowercased>\nIssued: <issued>`
 * (built via `buildAffiliateSignMessage('bind referral code ' + code, ...)`).
 * `referredWallet` doubles as the recovered signer the backend checks.
 */
export interface RefBindRequestBody {
  referredWallet: string
  code: string
  issued: number
  signature: string
}

export function bindRefCode(body: RefBindRequestBody): Promise<RefBindResponse> {
  return fetch(`${REBATES_API}/ref/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(),
  }).then((res) => parseJson<RefBindResponse>(res))
}

export function createRefCode(body: SignedRequestBody): Promise<RefCodeCreateResponse> {
  return fetch(`${REBATES_API}/ref/codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(),
  }).then((res) => parseJson<RefCodeCreateResponse>(res))
}

/**
 * GET /leaderboard?limit=N[&self=<address>]. When `self` (the connected wallet)
 * is passed, the backend marks that wallet's own row with `isSelf: true` (matched
 * on the full address within one snapshot). The self-marked response is
 * caller-specific, so the backend returns it `private, no-store`.
 */
export function getLeaderboard(limit = 100, self?: string): Promise<LeaderboardResponse> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (self) params.set('self', self.toLowerCase())
  return fetch(`${REBATES_API}/leaderboard?${params.toString()}`).then((res) =>
    parseJson<LeaderboardResponse>(res),
  )
}

export function getAffiliateStats(wallet: string): Promise<AffiliateStats> {
  return fetch(`${REBATES_API}/affiliate/${encodeURIComponent(wallet.toLowerCase())}`).then((res) =>
    parseJson<AffiliateStats>(res),
  )
}

/**
 * GET /rank/:wallet returns the machine-readable RankStatus payload (tier,
 * 30d volume, progress to next tier, leaderboard position). Used by the
 * Profile rank chip. 404 (no volume yet) is handled by the caller as Unranked.
 */
export function getRankStatus(wallet: string): Promise<RankStatus> {
  return fetch(`${REBATES_API}/rank/${encodeURIComponent(wallet.toLowerCase())}`, {
    headers: { accept: 'application/json' },
  }).then((res) => parseJson<RankStatus>(res))
}

export function getPartnerDashboard(body: SignedRequestBody): Promise<PartnerDashboard> {
  return fetch(`${REBATES_API}/partner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(),
  }).then((res) => parseJson<PartnerDashboard>(res))
}
