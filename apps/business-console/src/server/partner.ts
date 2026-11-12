// Partner figures: live. The real figures of a partner organisation, read from the Ophis rebate indexer through its one
// token-gated route (apps/rebate-indexer/src/business.ts), only for the wallets this organisation has linked. The
// answer is checked field by field and rebuilt as a whitelist: what the browser gets is made here, never passed through.
// Any failure gives figures_unavailable: never examples, never a partial mix. The token stays in this file's one request.
import type { Hex } from 'viem'
import { checksum, readCapped, signedByKey } from './chain.ts'
import * as data from './data.ts'
import { CHAIN_NAME } from './typed.ts'

export const INDEXER = { timeoutMs: 5000, maxBytes: 1_000_000, maxWallets: 10, maxReferred: 500, maxMonths: 12, maxCodes: 100, perHour: 120 }
type Settings = { DB: D1Database; ENVIRONMENT: string; INDEXER_URL?: string; INDEXER_TOKEN?: string }
const hex = (v: string) => /^0x[0-9a-f]*$/i.test(v)

/** Where the indexer is, or null: https, or (local environment only) plain http to this machine. */
export function indexerBase(env: { ENVIRONMENT: string; INDEXER_URL?: string }) {
  let url: URL
  try {
    url = new URL(env.INDEXER_URL ?? '')
  } catch {
    return null
  }
  const here = env.ENVIRONMENT === 'local' && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  if ((url.protocol !== 'https:' && !here) || url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

// ---- the check of the answer: each reader returns the value, or throws ----
const named = (name: string) => Object.assign(new Error(name), { name })
const no = (): never => {
  throw named('shape')
}
// A number: finite and not negative. NaN fails both comparisons, Infinity the upper one (no amount is near 1e15).
const num = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1e15 ? v : no())
const int = (v: unknown) => (Number.isInteger(num(v)) ? (v as number) : no())
const text = (v: unknown, form: RegExp) => (typeof v === 'string' && form.test(v) ? v : no())
const iso = (v: unknown) => (Number.isNaN(Date.parse(text(v, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/))) ? no() : (v as string))
const one = <T extends string>(v: unknown, of: readonly T[]) => (of.includes(v as T) ? (v as T) : no())
const list = (v: unknown, max: number) => (Array.isArray(v) && v.length <= max ? (v as unknown[]) : no())
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : no())
const ADDRESS = /^0x[0-9a-f]{40}$/
// How a referred wallet was attributed, in plain words: the indexer's three values.
const ATTRIBUTED = { link: 'Referral link', code: 'Partner code in the order', 'link-and-code': 'Referral link and partner code' } as const

// NOT read and never passed on: affiliate.currentCycleNetFeeUsd, fees.currentCycle.grossFeeUsd, fees.partnerShareBps,
// fees.minPayoutUsd, fees.nextPayoutAt. The partner view shows only what the partner earns and states no payout terms.
function affiliateOf(v: unknown, wallet: string) {
  if (v === null) return null
  const a = obj(v)
  if (a.wallet !== wallet) no()
  const scheduled = one(a.payoutStatus, ['disabled', 'not-configured', 'dry-run', 'scheduled'] as const) === 'scheduled'
  const next = a.nextPayoutAt === null ? null : iso(a.nextPayoutAt)
  const sharePct = num(a.rateOfNetFeePct)
  if (sharePct > 100) no()
  return {
    kind: one(a.kind, ['partner', 'regular'] as const), sharePct,
    codes: list(a.activeCodes, INDEXER.maxCodes).map((code) => text(code, /^[a-z0-9_-]{3,64}$/)),
    referredCount: int(a.referredCount), cycleVolumeUsd: num(a.currentCycleVolumeUsd), lifetimeVolumeUsd: num(a.lifetimeReferredVolumeUsd),
    estimatedEarningsUsd: num(a.estimatedCurrentCycleEarningsUsd), paidWeth: num(a.paidToDateWeth), paidUsd: num(a.paidToDateUsd),
    // The date of the next run, only when a run is scheduled: any other status reads "No payout run is scheduled."
    nextPayoutAt: scheduled ? next : null,
    referred: list(a.referees, INDEXER.maxReferred).map(obj).map((r) => {
      if (r.boundAt !== null) iso(r.boundAt)
      return { wallet: text(r.wallet, ADDRESS), attributed: ATTRIBUTED[one(r.attribution, ['link', 'code', 'link-and-code'] as const)], firstSeenAt: iso(r.firstSeenAt), lifetimeVolumeUsd: num(r.lifetimeVolumeUsd) }
    }),
  }
}
function feesOf(v: unknown, wallet: string) {
  const f = obj(v)
  const [cycle, life] = [obj(f.currentCycle), obj(f.lifetime)]
  if (f.recipient !== wallet) no()
  return {
    // Owed this cycle: the partner's share plus what was carried.
    shareUsd: num(cycle.partnerShareUsd), carriedUsd: num(cycle.carriedInUsd), owedUsd: num(cycle.owedUsd), pendingTrades: int(cycle.pendingUnpricedTrades),
    paidWeth: num(life.paidWeth), trades: int(life.tradeCount),
    months: list(f.recentBatches, INDEXER.maxMonths).map(obj).map((m) => ({
      month: text(m.cycleMonth, /^\d{4}-(0[1-9]|1[0-2])$/), status: text(m.status, /^[a-z][a-z_-]{0,23}$/), owedUsd: num(m.owedUsd), owedWeth: num(m.owedWeth), carriedUsd: num(m.carriedUsd),
    })),
  }
}

/** fees null: a contract wallet whose chain the indexer has not confirmed. No figure of it was read. */
export type PartnerWallet = { wallet: string; label: string; chain: string; affiliate: ReturnType<typeof affiliateOf>; fees: ReturnType<typeof feesOf> | null }
export type Figures = { state: 'not_connected' | 'no_wallet' | 'figures_unavailable' | 'figures_rate' } | { state: 'live'; asOf: string; leftOut: number; wallets: PartnerWallet[] }

/**
 * The figures of the session's organisation. The wallets come from its rows (state linked), never from the request:
 * distinct addresses, oldest first, at most 10. ONE request to the indexer: 5 seconds, no redirect followed, 1 MB.
 * A link proved by the wallet's own key holds on every chain. A link proved by a contract signature (a Safe) holds on
 * the chain it was proved on, and the same address can be another contract elsewhere: such a wallet is asked with its
 * chains (`contract`), and the indexer reads it only on the chain it pins that wallet to. Else it answers fees null.
 * At most 120 requests per organisation and clock hour (figures_rate): the indexer counts the console as one caller,
 * so without this one member reloading the page could use up the minute of every partner.
 */
export async function figures(env: Settings, orgId: string, now: number): Promise<Figures> {
  const base = indexerBase(env)
  if (!base || !env.INDEXER_TOKEN) return { state: 'not_connected' }
  const rows = new Map<string, { label: string; chains: number[]; key: boolean }>()
  for (const w of await data.linkedProofs(env.DB, orgId)) {
    const seen = rows.get(w.address) ?? rows.set(w.address, { label: w.label, chains: [], key: false }).get(w.address)!
    seen.chains.push(w.chainId)
    seen.key ||= hex(w.digest) && hex(w.signature) && (await signedByKey(w.digest as Hex, w.address, w.signature as Hex))
  }
  const asked = [...rows.keys()].slice(0, INDEXER.maxWallets)
  if (!asked.length) return { state: 'no_wallet' }
  if (!(await data.countHour(env.DB, `figures:${orgId}`, now, INDEXER.perHour))) return { state: 'figures_rate' }
  const contract = Object.fromEntries(asked.filter((a) => !rows.get(a)!.key).map((a) => [a, rows.get(a)!.chains]))
  try {
    const response = await fetch(`${base}/business/partner`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.INDEXER_TOKEN}` }, body: JSON.stringify({ wallets: asked, contract }),
      redirect: 'manual', signal: AbortSignal.timeout(INDEXER.timeoutMs), // a redirect is not followed: its status is a failure below
    })
    if (response.status !== 200) throw named('status')
    const body = await readCapped(response.body, INDEXER.maxBytes)
    if (body === null) throw named('size')
    if (body.includes(env.INDEXER_TOKEN)) throw named('echo') // the token comes back in no form, not even as a value that would pass
    const answer = obj(JSON.parse(body))
    const got = list(answer.wallets, INDEXER.maxWallets)
    // Exactly the wallets asked, each once, in the order asked.
    if (got.length !== asked.length) no()
    const wallets = got.map(obj).map((w, i) => {
      const [address, row] = [asked[i], rows.get(asked[i])!]
      if (w.wallet !== address) no()
      // "No figures" is an answer only for a wallet asked as a contract wallet, and then it has no partner figures either.
      const refused = w.fees === null && w.affiliate === null && Object.hasOwn(contract, address)
      return { wallet: checksum(address), label: row.label, chain: row.chains.map((id) => CHAIN_NAME[id] ?? `Chain ${id}`).join(', '), affiliate: affiliateOf(w.affiliate, address), fees: refused ? null : feesOf(w.fees, address) }
    })
    return { state: 'live', asOf: iso(answer.asOf), leftOut: rows.size - asked.length, wallets }
  } catch (error) {
    // The log carries one word: no address of the service, no token, no wallet.
    console.error('partner figures unavailable', error instanceof Error ? error.name : 'unknown')
    return { state: 'figures_unavailable' }
  }
}

/** The CSV tables of a partner, from a fresh read: every referred wallet, and the partner-fee months. */
export const tables = (f: Extract<Figures, { state: 'live' }>): Record<string, [head: string[], rows: unknown[][]]> => ({
  referred: [['Partner wallet', 'Wallet name', 'Referred wallet', 'Attributed by', 'First seen (UTC)', 'Lifetime volume (USD)'],
    f.wallets.flatMap((w) => (w.affiliate?.referred ?? []).map((r) => [w.wallet, w.label, r.wallet, r.attributed, r.firstSeenAt, r.lifetimeVolumeUsd]))],
  months: [['Partner wallet', 'Wallet name', 'Month', 'Status', 'Owed (USD)', 'Owed (WETH)', 'Carried (USD)'],
    f.wallets.flatMap((w) => (w.fees?.months ?? []).map((m) => [w.wallet, w.label, m.month, m.status, m.owedUsd, m.owedWeth, m.carriedUsd]))],
})
