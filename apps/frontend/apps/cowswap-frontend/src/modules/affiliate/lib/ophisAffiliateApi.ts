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

export const REBATES_API = process.env.REACT_APP_REBATES_API || 'https://rebates.ophis.fi'

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
  currentCycleVolumeUsd: number
}

export interface PartnerReferee {
  wallet: string
  boundAt: string
  lifetimeVolumeUsd: number
}

/** POST /partner (whitelist + signature gated) */
export interface PartnerDashboard extends AffiliateStats {
  referees: PartnerReferee[]
}

export type AffiliateSignedAction = 'Partner Dashboard access' | 'create referral code'

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
    throw new AffiliateApiError(res.status)
  }
  return (await res.json()) as T
}

export function lookupRefCode(code: string): Promise<RefLookupResponse> {
  return fetch(`${REBATES_API}/ref/${encodeURIComponent(code)}`).then((res) =>
    parseJson<RefLookupResponse>(res),
  )
}

export function bindRefCode(referredWallet: string, code: string): Promise<RefBindResponse> {
  return fetch(`${REBATES_API}/ref/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ referredWallet, code }),
  }).then((res) => parseJson<RefBindResponse>(res))
}

export function createRefCode(body: SignedRequestBody): Promise<RefCodeCreateResponse> {
  return fetch(`${REBATES_API}/ref/codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => parseJson<RefCodeCreateResponse>(res))
}

export function getAffiliateStats(wallet: string): Promise<AffiliateStats> {
  return fetch(`${REBATES_API}/affiliate/${encodeURIComponent(wallet.toLowerCase())}`).then((res) =>
    parseJson<AffiliateStats>(res),
  )
}

export function getPartnerDashboard(body: SignedRequestBody): Promise<PartnerDashboard> {
  return fetch(`${REBATES_API}/partner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => parseJson<PartnerDashboard>(res))
}
