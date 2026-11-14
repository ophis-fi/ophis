// Partner figures: live. The partner fee of a partner organisation (the fee it sets on its integration's orders), read
// from the Ophis rebate indexer through its one token-gated route (apps/rebate-indexer/src/business.ts), only for the
// wallets this organisation has linked. No referral share: the console's partners get none. The answer is checked
// field by field and rebuilt as a whitelist: what the browser gets is made here, never passed through.
// Any failure gives figures_unavailable: never examples, never a partial mix. The token stays in this file's one request.
// The same answer holds the wallets that traded through the integration, with their trades and volume (tradersOf), and
// the breakdown: the flow by day, by chain and by fee token, and the payouts (breakdownOf).
import type { Hex } from 'viem'
import { checksum, readCapped, signedByKey } from './chain.ts'
import * as data from './data.ts'
import { CHAIN_NAME } from './typed.ts'

export const INDEXER = { timeoutMs: 5000, maxBytes: 1_000_000, maxWallets: 10, maxMonths: 12, maxTraders: 100, maxDays: 90, maxRows: 100, maxPayouts: 24, perHour: 120 }
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
const list = (v: unknown, max: number) => (Array.isArray(v) && v.length <= max ? (v as unknown[]) : no())
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : no())
// NOT read and never passed on: fees.currentCycle.grossFeeUsd, fees.partnerShareBps, fees.minPayoutUsd, fees.nextPayoutAt.
// The partner view shows only what the partner earns and states no payout terms.
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
// The wallets that traded through the integration: the owners of the orders that carried this wallet's fee, lifetime.
// At most 100, the largest first (the indexer's order); unknown, the trades of no known wallet (sales of native ETH);
// the totals over every trade. Each with its trades, volume, and trades not priced yet (counted, not in the volume).
const figuresOf = (v: unknown) => {
  const f = obj(v)
  return { trades: int(f.trades), volumeUsd: num(f.volumeUsd), unpriced: int(f.unpriced) }
}
function tradersOf(v: unknown) {
  const t = obj(v)
  return {
    wallets: list(t.wallets, INDEXER.maxTraders).map(obj).map((w) => ({ wallet: checksum(text(w.wallet, /^0x[0-9a-f]{40}$/)), ...figuresOf(w) })),
    unknown: figuresOf(t.unknown),
    totals: { walletCount: int(obj(t.totals).walletCount), ...figuresOf(t.totals) },
  }
}
const UNKNOWN = 'Not known (native ETH sales)'
// The breakdown. daily: the last 90 days up to asOf's day, oldest first, each day once; byChain: every trade; byToken: the
// 100 tokens the fee was taken in with the largest share; payouts: the 24 newest. shareUsd is the partner's share (what
// "Owed this cycle" counts), never the gross fee. A tx is 32 bytes of hex, or null before the payout is executed.
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const chainOf = (v: unknown) => {
  const chainId = int(v)
  return { chainId: chainId > 0 ? chainId : no(), chain: CHAIN_NAME[chainId] ?? `Chain ${chainId}` }
}
const flowOf = (v: unknown) => ({ ...figuresOf(v), shareUsd: num(obj(v).shareUsd) })
function breakdownOf(v: unknown, asOf: string) {
  const b = obj(v)
  const [first, last] = [new Date(Date.parse(asOf) - 89 * 86_400_000).toISOString().slice(0, 10), asOf.slice(0, 10)]
  const days = list(b.daily, INDEXER.maxDays).map(obj).map((d) => ({ day: text(d.day, DAY), ...flowOf(d) }))
  // A day that exists (no 31 November), inside the 90 days, after the one before it.
  if (days.some((d, i) => new Date(d.day).toISOString().slice(0, 10) !== d.day || d.day < first || d.day > last || (i > 0 && d.day <= days[i - 1].day))) no()
  return {
    daily: days,
    byChain: list(b.byChain, INDEXER.maxRows).map(obj).map((c) => ({ ...chainOf(c.chainId), ...flowOf(c) })),
    byToken: list(b.byToken, INDEXER.maxRows).map(obj).map((t) => ({ ...chainOf(t.chainId), token: checksum(text(t.token, /^0x[0-9a-f]{40}$/)), trades: int(t.trades), shareUsd: num(t.shareUsd), unpriced: int(t.unpriced) })),
    payouts: list(b.payouts, INDEXER.maxPayouts).map(obj).map((p) => ({
      date: text(p.date, DAY), weth: num(p.weth), ...chainOf(p.chainId), tx: p.txHash === null ? null : text(p.txHash, /^0x[0-9a-f]{64}$/), status: text(p.status, /^[a-z][a-z_-]{0,23}$/),
    })),
  }
}

/** fees, traders and breakdown null: a contract wallet whose chain the indexer has not confirmed. No figure of it was read. */
export type PartnerWallet = { wallet: string; label: string; chain: string; fees: ReturnType<typeof feesOf> | null; traders: ReturnType<typeof tradersOf> | null; breakdown: ReturnType<typeof breakdownOf> | null }
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
    // Free plan: the link wrote how it was proved (proof_by), the same recovery made once. A row from before: recovered here.
    seen.key ||= w.proofBy ? w.proofBy === 'key' : hex(w.digest) && hex(w.signature) && (await signedByKey(w.digest as Hex, w.address, w.signature as Hex))
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
    const asOf = iso(answer.asOf)
    const got = list(answer.wallets, INDEXER.maxWallets)
    // Exactly the wallets asked, each once, in the order asked.
    if (got.length !== asked.length) no()
    const wallets = got.map(obj).map((w, i) => {
      const [address, row] = [asked[i], rows.get(asked[i])!]
      if (w.wallet !== address) no()
      // "No figures" is an answer only for a wallet asked as a contract wallet, and only whole: no fees, no traders, no breakdown.
      const refused = w.fees === null && w.traders === null && w.breakdown === null && Object.hasOwn(contract, address)
      return {
        wallet: checksum(address), label: row.label, chain: row.chains.map((id) => CHAIN_NAME[id] ?? `Chain ${id}`).join(', '),
        fees: refused ? null : feesOf(w.fees, address), traders: refused ? null : tradersOf(w.traders), breakdown: refused ? null : breakdownOf(w.breakdown, asOf),
      }
    })
    return { state: 'live', asOf, leftOut: rows.size - asked.length, wallets }
  } catch (error) {
    // The log carries one word: no address of the service, no token, no wallet.
    console.error('partner figures unavailable', error instanceof Error ? error.name : 'unknown')
    return { state: 'figures_unavailable' }
  }
}

/** The CSV tables of a partner, from a fresh read: the partner-fee months, the wallets that traded, and the four of the
 * breakdown. The wallets that traded end, for each partner wallet, with the trades of no known wallet (when there are)
 * and the total of every trade. */
export const tables = (f: Extract<Figures, { state: 'live' }>): Record<string, [head: string[], rows: unknown[][]]> => ({
  months: [['Partner wallet', 'Wallet name', 'Month', 'Status', 'Owed (USD)', 'Owed (WETH)', 'Carried (USD)'],
    f.wallets.flatMap((w) => (w.fees?.months ?? []).map((m) => [w.wallet, w.label, m.month, m.status, m.owedUsd, m.owedWeth, m.carriedUsd]))],
  traders: [['Partner wallet', 'Wallet name', 'Wallet', 'Trades', 'Volume (USD)', 'Trades not priced yet'],
    f.wallets.flatMap(({ wallet, label, traders: t }) => {
      if (!t) return []
      const row = (name: string, x: ReturnType<typeof figuresOf>) => [wallet, label, name, x.trades, x.volumeUsd, x.unpriced]
      const n = t.totals.walletCount
      return [...t.wallets.map((x) => row(x.wallet, x)), ...(t.unknown.trades ? [row(UNKNOWN, t.unknown)] : []), row(`Total, ${n} ${n === 1 ? 'wallet' : 'wallets'}`, t.totals)]
    })],
  daily: [['Partner wallet', 'Wallet name', 'Day', 'Trades', 'Volume (USD)', 'Your share (USD)', 'Trades not priced yet'],
    f.wallets.flatMap((w) => (w.breakdown?.daily ?? []).map((d) => [w.wallet, w.label, d.day, d.trades, d.volumeUsd, d.shareUsd, d.unpriced]))],
  chains: [['Partner wallet', 'Wallet name', 'Chain', 'Trades', 'Volume (USD)', 'Your share (USD)', 'Trades not priced yet'],
    f.wallets.flatMap((w) => (w.breakdown?.byChain ?? []).map((c) => [w.wallet, w.label, c.chain, c.trades, c.volumeUsd, c.shareUsd, c.unpriced]))],
  tokens: [['Partner wallet', 'Wallet name', 'Chain', 'Fee token', 'Trades', 'Your share (USD)', 'Trades not priced yet'],
    f.wallets.flatMap((w) => (w.breakdown?.byToken ?? []).map((t) => [w.wallet, w.label, t.chain, t.token, t.trades, t.shareUsd, t.unpriced]))],
  payouts: [['Partner wallet', 'Wallet name', 'Date', 'Amount (WETH)', 'Chain', 'Transaction', 'Status'],
    f.wallets.flatMap((w) => (w.breakdown?.payouts ?? []).map((p) => [w.wallet, w.label, p.date, p.weth, p.chain, p.tx, p.status]))],
})
