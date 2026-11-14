// Overview and Desk. An institution: its desk is real (src/server/orders.ts): an order is prepared on a live quote,
// approved by a second person, then signed by the organisation's own wallet on the signing page. Its overview figures
// (balances, statement) are the server's examples (src/server/demo.ts). A partner: live figures from the Ophis rebate
// service, checked and rebuilt by the server (src/server/partner.ts). This file holds no price and builds no order.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, CANCELLED, capital, Icon, ROLE, save, say, sensitive, Section, stamp, Status, Tile } from './ui.tsx'

// What an approval binds (the server's terms; amounts in atoms) and the same in words, made by the server.
interface Terms { type: 'market' | 'limit'; chainId: number; walletId: string; wallet: string; label: string; scheme: 'eip712' | 'presign'; sell: { symbol: string; amount: string }; buy: { symbol: string; minimum: string }; quoted: string; slippageBips: number | null; limitPrice: string | null; validFor: number }
interface Words { sell: string; buy: string; type: string; chain: string; wallet: string; valid: string; fee: string }
export interface OrderBody { terms: Terms; words: Words }
// A row of the blotter: an order of this organisation, its state, and what the orderbook did with it.
interface Order extends OrderBody { id: string; ref: string; at: number; state: string; open: boolean; mine: boolean; preparer: string; preparerRole: string; decidedBy: string | null; decidedAt: number | null; uid: string | null; sold: string | null; bought: string | null; tx: string | null; signUntil: number | null }
interface Institution {
  kind: 'institution'; waiting: number; asOf: string; totalEur: string
  balances: { wallet: string; address: string; chain: string; total: string; rows: { asset: string; balance: string; valueEur: string }[] }[]
  months: { month: string; trades: number; volumeEur: string; feeBps: string; feeEur: string }[]
  orders: Order[]
}
// A partner's figures: live, or the plain reason why there are none. Numbers are USD or WETH amounts of the rebate service.
interface PartnerWallet {
  wallet: string; label: string; chain: string
  // null: a contract wallet whose chain the rebate service has not confirmed; no figure of it was read.
  fees: null | { shareUsd: number; carriedUsd: number; owedUsd: number; pendingTrades: number; paidWeth: number; trades: number; months: { month: string; status: string; owedUsd: number; owedWeth: number; carriedUsd: number }[] }
  // The wallets that traded through the integration: at most 100, the largest first; unknown, the trades of no known wallet;
  // the totals count every trade. unpriced: trades counted but not yet in the volume. null with fees.
  traders: null | { wallets: (Traded & { wallet: string })[]; unknown: Traded; totals: Traded & { walletCount: number } }
  // The last 90 days (oldest first, days with trades only), by chain, by fee token, and the payouts. shareUsd: the partner's
  // share. tx: null until the payout is executed. null with fees.
  breakdown: null | {
    daily: (Flow & { day: string })[]; byChain: (Flow & OnChain)[]; byToken: (OnChain & { token: string; trades: number; shareUsd: number; unpriced: number })[]
    payouts: (OnChain & { date: string; weth: number; tx: string | null; status: string })[]
  }
  // The wallets on a sanctions list that traded through the integration, over every trade. null with fees.
  sanctioned: null | Listed[]
}
type Listed = Traded & { wallet: string; lists: string[]; firstAt: string | null; lastAt: string | null }
type Traded = { trades: number; volumeUsd: number; unpriced: number }
type Flow = Traded & { shareUsd: number }
type OnChain = { chainId: number; chain: string }
interface Partner {
  kind: 'partner'; waiting: number
  figures: { state: 'not_connected' | 'no_wallet' | 'figures_unavailable' | 'figures_rate' } | { state: 'live'; asOf: string; leftOut: number; lists: { name: string; published: string | null; loaded: string }[]; wallets: PartnerWallet[] }
}
interface DeskView {
  chains: { id: number; name: string }[]; assets: { chainId: number; chain: string; symbol: string; token: string; decimals: number; cap: string }[]
  validity: number[]; slippage: { default: number; max: number }; maxOpen: number
  wallets: { id: string; label: string; address: string; chainId: number; chain: string; scheme: string }[]; mayPrepare: boolean; maySign: boolean; orders: Order[]
}

/** A decimal string of the server with thousands separators and `dp` decimals (cut). Text only: no number is made of it. */
export function money(text: string, dp = 2) {
  const [whole, part = ''] = text.split('.')
  return `${whole.replace(/\B(?=(\d{3})+$)/g, ',')}${dp ? `.${part.padEnd(dp, '0').slice(0, dp)}` : ''}`
}
const places = (asset: string) => (asset === 'ETH' ? 4 : 2)
const count = (n: number) => money(String(n), 0)
const short = (address: string) => (address.length > 13 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address)
/** An order in words, as the Approvals list and the record say it. Every amount whole, as the server wrote it. */
export const orderWords = ({ terms, words }: OrderBody) => `Sell ${words.sell} for ${words.buy}, ${terms.type}, ${words.chain}, from ${terms.label} (${short(terms.wallet)})`

const Banner = () => <p className="note warn demo" role="note"><Icon name="info" /><span className="grow"><b>Example figures.</b> The balances and the statement are examples. Your orders below are real.</span></p>

/** "Export CSV": the server builds the file, the browser saves it. */
function Export({ table, size = 'sm', label = 'Export CSV' }: { table: string; size?: 'sm' | 'md'; label?: string }) {
  const [failed, setFailed] = useState(false)
  async function run() {
    const out = await api<{ name: string; csv: string }>(`/api/export/${table}`)
    setFailed(out.status !== 200)
    if (out.status === 200) save(out.data.name, out.data.csv)
  }
  return <button className={`btn ghost ${size}`} type="button" onClick={run}><Icon name="download" size={16} />{failed ? 'Export failed. Try again' : label}</button>
}

function Table({ head, rows, foot }: { head: string[]; rows: ReactNode[][]; foot?: ReactNode[] }) {
  const cls = (i: number) => (/\(USD\)|\(EUR\)|\(WETH\)|^(Trades|Wallets|Balance|Sell|Buy|bps|EUR)$/.test(head[i]) ? 'num' : undefined)
  return (
    <div className="table-wrap">
      <table className="t">
        <thead><tr>{head.map((h, i) => <th key={h} className={cls(i)}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i} className={cls(i)}>{cell}</td>)}</tr>)}</tbody>
        {foot && <tfoot><tr>{foot.map((cell, i) => <td key={i} className={cls(i)}>{cell}</td>)}</tr></tfoot>}
      </table>
    </div>
  )
}
const orderCell = (o: Order, pick?: (o: Order) => void) => (
  <>{pick ? <button className="link mono" type="button" onClick={() => pick(o)}>{o.ref}</button> : <span className="mono">{o.ref}</span>}<small>{stamp(o.at)}</small></>
)

function useView<T>(path: string, onSignedOut: () => void) {
  const [view, setView] = useState<T>()
  const [problem, setProblem] = useState('')
  const load = useCallback(async () => {
    const result = await api<T & { error?: string }>(path)
    if (result.status === 401) return onSignedOut()
    if (result.status === 200) return setView(result.data)
    setProblem(result.data.error === 'institution_only' ? say(result.data) : 'This page could not be loaded. Reload it.')
  }, [path, onSignedOut])
  useEffect(() => void load(), [load])
  return { view, problem, load }
}

export function Overview({ onSignedOut }: { onSignedOut: () => void }) {
  const { view, problem, load } = useView<Institution | Partner>('/api/overview', onSignedOut)
  if (!view) return problem ? <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{problem}</span></p> : null
  return view.kind === 'partner' ? <PartnerOverview v={view} retry={load} /> : <InstitutionOverview v={view} />
}

function InstitutionOverview({ v }: { v: Institution }) {
  const month = v.months[0]
  return (
    <>
      <header className="ph">
        <div><span className="cap eyebrow">Institution console</span><h1 className="h-page">Your position, <em>in one view</em>.</h1><p className="lede">Position at {v.asOf}. Reporting currency: EUR.</p></div>
        <div className="acts"><a className="btn ghost md" href="/#/desk"><Icon name="arrow-left-right" size={16} />Open the desk</a></div>
      </header>
      <Banner />
      <div className="stats">
        <div className="c"><span className="num">{money(v.totalEur)}</span><span className="cap"><Icon name="landmark" size={16} />Total value (EUR)</span><span className="sub">Across {v.balances.length} example wallets</span></div>
        <div className="c"><span className="num">{month.trades}</span><span className="cap"><Icon name="arrow-left-right" size={16} />Orders this month</span><span className="sub">Volume {money(month.volumeEur)} EUR</span></div>
        <div className="c"><span className="num">{money(month.feeEur)}</span><span className="cap"><Icon name="receipt" size={16} />Fees this month (EUR)</span><span className="sub">{month.feeBps} bps of volume</span></div>
        <div className="c"><span className="num" data-waiting>{v.waiting}</span><span className="cap"><Icon name="users" size={16} />Waiting for approval</span><span className="sub"><a className="link" href="/#/organisation">Open approvals</a></span></div>
      </div>
      <div className="g even sec">
        <Section icon="wallet" title="Balances by wallet" hint="Example wallets and balances, not your linked wallets." action={<Export table="balances" />}>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Asset</th><th className="num">Balance</th><th className="num">Value (EUR)</th></tr></thead>
              <tbody>{v.balances.flatMap((w) => [
                <tr className="grp" key={w.wallet}><td colSpan={3}><div className="gr"><span><Icon name="wallet" size={16} /> <b>{w.wallet}</b> <span className="mono muted">{w.address}</span></span><span>{w.chain}</span></div></td></tr>,
                ...w.rows.map((r) => <tr key={w.wallet + r.asset}><td>{r.asset}</td><td className="num">{money(r.balance, places(r.asset))}</td><td className="num">{money(r.valueEur)}</td></tr>),
              ])}</tbody>
              <tfoot><tr><td>Total, {v.balances.length} wallets</td><td /><td className="num">{money(v.totalEur)}</td></tr></tfoot>
            </table>
          </div>
        </Section>
        <Section icon="history" title="Recent orders" hint="Your own orders, newest first, with their real state." action={<div className="acts"><Export table="orders" /><a className="btn ghost sm" href="/#/desk">All orders</a></div>}>
          {v.orders.length ? <Table head={['Order', 'Sell, buy', 'Status']} rows={v.orders.slice(0, 8).map((o) => [orderCell(o), <>{o.words.sell}<small>for {o.words.buy}</small></>, <Status>{o.state}</Status>])} /> : <p className="muted">No order yet. Orders are prepared on the desk.</p>}
        </Section>
      </div>
      <Section icon="receipt" title="Monthly fee statement" hint="Example statement. Orders on Optimism or Unichain." action={<Export table="statement" />}>
        <Table head={['Fee line (EUR)', ...v.months.map((m) => m.month)]} rows={[
          ['Trades', ...v.months.map((m) => m.trades)], ['Volume', ...v.months.map((m) => money(m.volumeEur))], [`Fee (${month.feeBps} bps of volume)`, ...v.months.map((m) => money(m.feeEur))],
        ]} foot={['Total', ...v.months.map((m) => money(m.feeEur))]} />
      </Section>
    </>
  )
}

// ---- a partner's overview: live figures only, and no banner. ----
const usd = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const weth = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 })
const ESTIMATE = 'Estimate. The amount is fixed when a payout is made.'
// A volume (or a share) with trades not priced yet says so under it: a bare 0.00 would read as no volume.
const volume = (x: { unpriced: number; volumeUsd?: number }, n = x.volumeUsd ?? 0) => <>{usd(n)}{x.unpriced > 0 && <small>{count(x.unpriced)} {x.unpriced === 1 ? 'trade' : 'trades'} not priced yet</small>}</>

// The block explorer of a payout's transaction, by chain: the indexer's own links (EXPLORER_TX_URL there).
const EXPLORER: Record<number, string> = { 100: 'https://gnosisscan.io/tx/', 10: 'https://optimistic.etherscan.io/tx/', 130: 'https://uniscan.xyz/tx/' }
const PAYOUT: Record<string, string> = { executed: 'Paid', proposed: 'Waiting for signatures', proposing: 'Waiting for signatures', computed: 'Not sent yet' }
const DAY_MS = 86_400_000
// The trades of a row, under its first cell: three columns fit a phone.
const trades = (n: number) => <small>{count(n)} {n === 1 ? 'trade' : 'trades'}</small>

/** The daily volume of the last 90 days in plain SVG, one bar per day with trades, asOf's day on the right; the same days as a table under it. */
function DailyVolume({ days, asOf }: { days: (Flow & { day: string })[]; asOf: string }) {
  const end = Date.parse(asOf.slice(0, 10))
  const [first, last] = [new Date(end - 89 * DAY_MS).toISOString().slice(0, 10), asOf.slice(0, 10)]
  const top = Math.max(...days.map((d) => d.volumeUsd))
  const unpriced = days.reduce((n, d) => n + d.unpriced, 0)
  return (
    <>
      <figure className="bars">
        <svg viewBox="0 0 900 100" preserveAspectRatio="none" role="img" aria-label={`Daily volume in USD from ${first} to ${last}. ${days.length} ${days.length === 1 ? 'day' : 'days'} with trades. The highest day: ${usd(top)}. The table under the chart lists each day.`}>
          {days.map((d) => {
            // A day of trades not priced yet only still gets a thin bar: it had trades.
            const h = Math.max(top ? (d.volumeUsd / top) * 100 : 0, 1)
            return <rect key={d.day} x={(89 - (end - Date.parse(d.day)) / DAY_MS) * 10 + 1} y={100 - h} width="8" height={h}><title>{`${d.day}: ${usd(d.volumeUsd)} USD, ${count(d.trades)} ${d.trades === 1 ? 'trade' : 'trades'}`}</title></rect>
          })}
        </svg>
        <figcaption><span>{first}</span><span>Highest day: {usd(top)} USD</span><span>{last}</span></figcaption>
      </figure>
      {unpriced > 0 && <p className="fine"><Icon name="clock" size={16} />{count(unpriced)} {unpriced === 1 ? 'trade is' : 'trades are'} not priced yet: in the table, not in the bars.</p>}
      <details className="disclose">
        <summary>Each day as a table<Icon name="chevron-down" /></summary>
        <div className="body"><Table head={['Day', 'Volume (USD)', 'Your share (USD)']} rows={days.map((d) => [<>{d.day}{trades(d.trades)}</>, volume(d), usd(d.shareUsd)])} /></div>
      </details>
    </>
  )
}

/** The wallets on a sanctions list that traded, over every partner wallet: one row each, its trades added up. Information only. */
function Sanctioned({ wallets }: { wallets: PartnerWallet[] }) {
  const all = new Map<string, Listed>()
  for (const s of wallets.flatMap((w) => w.sanctioned ?? [])) {
    const seen = all.get(s.wallet)
    const times = (a: string | null, b: string | null) => [a, b].filter((t): t is string => t !== null).sort() // ISO times sort as text
    all.set(s.wallet, seen ? { ...seen, trades: seen.trades + s.trades, volumeUsd: seen.volumeUsd + s.volumeUsd, unpriced: seen.unpriced + s.unpriced,
      firstAt: times(seen.firstAt, s.firstAt)[0] ?? null, lastAt: times(seen.lastAt, s.lastAt).at(-1) ?? null } : s)
  }
  const rows = [...all.values()]
  if (!rows.length) return null
  const n = rows.reduce((sum, s) => sum + s.trades, 0)
  return (
    <div className="note bad flagged" role="alert">
      <p><Icon name="triangle-alert" /><span className="grow"><b>{count(rows.length)} {rows.length === 1 ? 'wallet' : 'wallets'} on a sanctions list traded through your integration: {count(n)} {n === 1 ? 'trade' : 'trades'}, ${usd(rows.reduce((sum, s) => sum + s.volumeUsd, 0))}.</b> This is for your information. Nothing in your account changes.</span></p>
      {/* Three columns fit a phone: the lists and the trades under the wallet, the last trade under the first. */}
      <Table head={['Wallet', 'Volume (USD)', 'First trade']} rows={rows.map((s) => [
        <><span className="mono">{s.wallet}</span><small>{s.lists.join(', ')}</small>{trades(s.trades)}</>, volume(s),
        s.firstAt && s.lastAt ? <>{s.firstAt.slice(0, 10)}<small>Last {s.lastAt.slice(0, 10)}</small></> : 'Not known yet', // both or neither: no block time known yet
      ])} />
      <Export table="sanctioned" label="Sanctioned wallets CSV" />
    </div>
  )
}

function PartnerWalletFigures({ w, asOf }: { w: PartnerWallet; asOf: string }) {
  const [t, b] = [w.traders, w.breakdown]
  // A wallet on a sanctions list is tagged; one outside the 100 largest is added at the end.
  const listed = new Set(w.sanctioned?.map((s) => s.wallet))
  const outside = (w.sanctioned ?? []).filter((s) => !t?.wallets.some((x) => x.wallet === s.wallet))
  return (
    <section className="pw sec" aria-label={`Wallet ${w.label}`}>
      <h2 className="pw-head"><Icon name="wallet" /><b>{w.label}</b><span className="mono muted">{w.wallet}</span><span className="muted">{w.chain}</span></h2>
      {w.fees ? (
        <Section icon="hand-coins" title="Partner fee" hint="The fee you set on the orders of your integration.">
          <div className="stats">
            <div className="c"><span className="num">${usd(w.fees.owedUsd)}</span><span className="cap"><Icon name="hand-coins" size={16} />Owed this cycle</span><span className="sub">Your share ${usd(w.fees.shareUsd)} plus ${usd(w.fees.carriedUsd)} carried. {ESTIMATE}</span></div>
            <div className="c"><span className="num">{count(w.fees.pendingTrades)}</span><span className="cap"><Icon name="clock" size={16} />Trades waiting for a price</span></div>
            <div className="c"><span className="num">{weth(w.fees.paidWeth)}</span><span className="cap"><Icon name="receipt" size={16} />Paid to date (WETH)</span></div>
            <div className="c"><span className="num">{count(w.fees.trades)}</span><span className="cap"><Icon name="arrow-left-right" size={16} />Trades</span></div>
          </div>
          {w.fees.months.length ? <Table head={['Month', 'Status', 'Owed (USD)', 'Owed (WETH)', 'Carried (USD)']} rows={w.fees.months.map((m) => [m.month, <Status>{capital(m.status)}</Status>, usd(m.owedUsd), weth(m.owedWeth), usd(m.carriedUsd)])} />
            : <p className="muted">No month has been accounted yet.</p>}
        </Section>
      ) : <p className="note warn" role="note"><Icon name="info" /><span className="grow"><b>The figures of this wallet are not shown.</b> It is a contract wallet, and Ophis has not confirmed the chain it is controlled on. <a className="link" href="/#/support">Ask Support</a>.</span></p>}
      {b && (
        <>
          <Section icon="receipt" title="Payouts" hint="The payouts to this wallet, newest first, at most 24.">
            {b.payouts.length ? <Table head={['Date', 'Amount (WETH)', 'Status']} rows={b.payouts.map((p) => [
              <>{p.date}<small>{p.chain}</small></>, weth(p.weth),
              <><Status>{PAYOUT[p.status] ?? capital(p.status)}</Status>
                <small>{p.tx ? (EXPLORER[p.chainId] ? <a className="link mono" href={EXPLORER[p.chainId] + p.tx} target="_blank" rel="noopener" title={p.tx}>{short(p.tx)}</a> : <span className="mono">{p.tx}</span>) : 'No transaction yet'}</small></>,
            ])} /> : <p className="muted">No payout yet.</p>}
          </Section>
          <Section icon="calendar" title="Daily volume" hint="The last 90 days, by the day the trade settled (UTC). Volume is an estimate.">
            {b.daily.length ? <DailyVolume days={b.daily} asOf={asOf} /> : <p className="muted">No trade in the last 90 days.</p>}
          </Section>
          {b.byChain.length > 0 && (
            <div className="g even sec">
              <Section icon="globe" title="By chain" hint="Every trade, by the chain it settled on.">
                <Table head={['Chain', 'Volume (USD)', 'Your share (USD)']} rows={b.byChain.map((c) => [<>{c.chain}{trades(c.trades)}</>, volume(c), usd(c.shareUsd)])} />
              </Section>
              <Section icon="hand-coins" title="By fee token" hint="The token your fee was taken in, on its chain.">
                <Table head={['Fee token', 'Your share (USD)']} rows={b.byToken.map((x) => [<><span className="mono">{x.token}</span><small>{x.chain}, {count(x.trades)} {x.trades === 1 ? 'trade' : 'trades'}</small></>, volume(x, x.shareUsd)])} />
              </Section>
            </div>
          )}
        </>
      )}
      {t && (
        <Section icon="users" title="Wallets that traded through your integration" hint="The wallets whose orders carried your fee, since the first trade. Volume is an estimate.">
          {t.totals.trades ? (
            <>
              <div className="stats">
                <div className="c"><span className="num">{count(t.totals.walletCount)}</span><span className="cap"><Icon name="wallet" size={16} />Wallets</span></div>
                <div className="c"><span className="num">{count(t.totals.trades)}</span><span className="cap"><Icon name="arrow-left-right" size={16} />Trades</span></div>
                <div className="c"><span className="num">{usd(t.totals.volumeUsd)}</span><span className="cap"><Icon name="landmark" size={16} />Volume (USD)</span></div>
              </div>
              <Table head={['Wallet', 'Trades', 'Volume (USD)']} rows={[
                ...[...t.wallets, ...outside].map((x) => [<><span className="mono">{x.wallet}</span>{listed.has(x.wallet) && <Status>Sanctions list</Status>}</>, count(x.trades), volume(x)]),
                ...(t.unknown.trades ? [[<span className="muted">Not known (native ETH sales)</span>, count(t.unknown.trades), volume(t.unknown)]] : []),
              ]} />
              {t.totals.walletCount > t.wallets.length && <p className="fine"><Icon name="info" size={16} />The table shows the {t.wallets.length} largest wallets by volume.{outside.length > 0 && ' The wallets on a sanctions list are added at the end.'}</p>}
              {t.totals.unpriced > 0 && <p className="fine"><Icon name="clock" size={16} />Volume is priced each night. {count(t.totals.unpriced)} {t.totals.unpriced === 1 ? 'trade is' : 'trades are'} not priced yet.</p>}
            </>
          ) : <p className="muted">No wallet has traded through your integration yet.</p>}
        </Section>
      )}
    </section>
  )
}

function PartnerOverview({ v, retry }: { v: Partner; retry: () => Promise<void> }) {
  const f = v.figures
  const [busy, setBusy] = useState(false)
  return (
    <>
      <header className="ph">
        <div><span className="cap eyebrow">Partner console</span><h1 className="h-page">Your flow, <em>in one view</em>.</h1>
          {f.state === 'live' && <p className="lede">Figures from the Ophis rebate service, read at {stamp(Date.parse(f.asOf))}. Amounts in USD.</p>}</div>
        {f.state === 'live' && (
          <div className="acts"><Export table="months" size="md" label="Fee months CSV" /><Export table="payouts" size="md" label="Payouts CSV" /><Export table="daily" size="md" label="Daily CSV" />
            <Export table="chains" size="md" label="Chains CSV" /><Export table="tokens" size="md" label="Fee tokens CSV" /><Export table="traders" size="md" label="Trading wallets CSV" /></div>
        )}
      </header>
      {f.state === 'not_connected' && <p className="note warn" role="status" data-state={f.state}><Icon name="info" /><span className="grow"><b>Your figures are not connected yet.</b> This console is not connected to the Ophis rebate service. Nothing is wrong on your side. <a className="link" href="/#/support">Ask Support</a> when your figures will be connected.</span></p>}
      {f.state === 'no_wallet' && <p className="note warn" role="status" data-state={f.state}><Icon name="wallet" /><span className="grow"><b>No wallet is linked.</b> Figures are shown for the wallets your organisation has linked. <a className="link" href="/#/organisation">Link a wallet under Organisation</a>.</span></p>}
      {f.state === 'figures_rate' && <p className="note warn" role="status" data-state={f.state}><Icon name="info" /><span className="grow"><b>Too many reads.</b> Your organisation read its figures 120 times in this hour. They can be read again in the next hour.</span></p>}
      {f.state === 'figures_unavailable' && (
        <p className="note bad" role="alert" data-state={f.state}><Icon name="triangle-alert" /><span className="grow"><b>The figures are not available right now.</b> The rebate service did not give a usable answer. Nothing changed in your account. Try again in a minute.</span>
          <button className="btn ghost sm" type="button" disabled={busy} onClick={async () => (setBusy(true), await retry(), setBusy(false))}><Icon name="history" size={16} />Retry</button></p>
      )}
      {f.state === 'live' && (
        <>
          {f.leftOut > 0 && <p className="note" role="note"><Icon name="info" /><span className="grow">Figures are read for the 10 wallets linked first. {f.leftOut} more linked {f.leftOut === 1 ? 'wallet is' : 'wallets are'} not shown.</span></p>}
          <Sanctioned wallets={f.wallets} />
          <p className="fine checked"><Icon name="shield-check" size={16} />{f.lists.length ? `The wallets that traded are checked against: ${f.lists.map((l) => `${l.name}${l.published ? `, published ${l.published}` : ''}, loaded ${l.loaded}`).join('; ')}.`
            : 'No sanctions list is loaded. The wallets that traded are not checked.'}</p>
          {f.wallets.map((w) => <PartnerWalletFigures key={w.wallet} w={w} asOf={f.asOf} />)}
        </>
      )}
      {v.waiting > 0 && <p className="note"><Icon name="users" /><span className="grow"><b data-waiting>{v.waiting}</b> {v.waiting === 1 ? 'request waits' : 'requests wait'} for your approval. <a className="link" href="/#/organisation">Open approvals</a></span></p>}
    </>
  )
}

// ---- the desk ----
const TermsFacts = ({ o }: { o: OrderBody }) => (
  <>
    <dt>Order type</dt><dd>{o.words.type}</dd>
    <dt>You sell</dt><dd>{o.words.sell}</dd>
    <dt>You buy</dt><dd>{o.words.buy}</dd>
    <dt>Settle from</dt><dd>{o.terms.label}, <span className="mono">{o.terms.wallet}</span>. The wallet receives what is bought.</dd>
    <dt>Chain</dt><dd>{o.words.chain}</dd>
    <dt>Valid</dt><dd>{o.words.valid}</dd>
    <dt>Ophis fee</dt><dd>{o.words.fee}</dd>
  </>
)

function TicketForm({ v, onSent }: { v: DeskView; onSent: () => Promise<void> }) {
  const [t, setT] = useState({ type: 'market', walletId: v.wallets[0]?.id ?? '', sell: '', buy: '', amount: '', limitPrice: '', slippage: String(v.slippage.default / 100), validFor: v.validity[0] })
  const [review, setReview] = useState<OrderBody & { review: string }>()
  const [sent, setSent] = useState(false)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (change: Partial<typeof t>) => setT({ ...t, ...change })
  const wallet = v.wallets.find((w) => w.id === t.walletId) ?? v.wallets[0]
  const here = v.assets.filter((a) => a.chainId === wallet?.chainId)
  const [sell, buy] = [here.find((a) => a.symbol === t.sell) ?? here[0], here.find((a) => a.symbol === t.buy) ?? here[1]]
  async function ask(send: boolean, event?: FormEvent) {
    event?.preventDefault()
    setBusy(true)
    const ticket = { type: t.type, chainId: wallet.chainId, walletId: wallet.id, sell: sell?.symbol, buy: buy?.symbol, amount: t.amount.trim(), validFor: t.validFor,
      ...(t.type === 'limit' ? { limitPrice: t.limitPrice.trim() } : { slippageBips: Math.round(Number(t.slippage) * 100) }) }
    // The review needs no passkey. Sending does: when the last check is older than 5 minutes, the passkey is asked for here.
    const out = await (send ? sensitive : api)<OrderBody & { review: string; error?: string }>('/api/desk/orders', send ? { send: true, review: review?.review } : ticket).catch(() => null)
    setBusy(false)
    if (!out) return setProblem(CANCELLED) // the passkey step was cancelled or failed: the ticket is usable again
    setProblem(out.status === 200 ? '' : out.status === 403 && out.data.error === 'forbidden' ? 'Your role cannot prepare orders. A Trader, an Owner or an Admin prepares them.' : say(out.data))
    if (out.status !== 200) return
    if (!send) return setReview(out.data)
    setSent(true)
    await onSent()
  }
  const failed = problem && <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{problem}</span></p>
  if (!v.mayPrepare) return <p className="note"><Icon name="info" /><span className="grow"><b>Your role reads the desk.</b> A Trader, an Owner or an Admin prepares orders. The blotter and the records below are open to you.</span></p>
  if (!wallet) return <p className="note warn"><Icon name="wallet" /><span className="grow"><b>No wallet is linked.</b> An order settles from a linked wallet of the organisation. <a className="link" href="/#/organisation">Link one under Organisation</a>.</span></p>
  if (sent && review) {
    return (
      <div className="ticket" data-step="sent">
        <p className="note ok" role="status"><Icon name="circle-check" /><span className="grow"><b>Sent for approval.</b> {orderWords(review)}. A different member with a key role approves or refuses it under Approvals. Then the wallet signs it.</span></p>
        <div className="acts"><a className="btn ghost md" href="/#/organisation"><Icon name="users" size={16} />Open approvals</a><button className="btn primary md" type="button" onClick={() => (setSent(false), setReview(undefined))}><Icon name="pencil" size={16} />New order</button></div>
      </div>
    )
  }
  if (review) {
    return (
      <div className="ticket" data-step="review">
        <h3 className="h-card">Review order</h3>
        <dl className="kv"><TermsFacts o={review} /></dl>
        <p className="fine"><Icon name="info" size={16} />The least amount bought comes from a live quote of the orderbook. It is binding once approved. Send it for approval within 5 minutes, or review it again.</p>
        {failed}
        <div className="acts"><button className="btn ghost md" type="button" onClick={() => setReview(undefined)}>Back to the ticket</button><button className="btn primary md" type="button" disabled={busy} onClick={() => ask(true)}><Icon name="users" size={16} />Send for approval</button></div>
        <p className="fine"><Icon name="info" size={16} />Nothing is signed at this step. Sending asks for your passkey. A second person then approves it, with a passkey.</p>
      </div>
    )
  }
  const pills = (name: string, legend: string, options: [value: string, label: string][], value: string, pick: (value: string) => void) => (
    <fieldset className="field"><legend>{legend}</legend><div className="pills">{options.map(([option, label]) => (
      <label className="pill" key={option}><input type="radio" name={name} value={option} checked={value === option} onChange={(event) => pick(event.target.value)} />{label}</label>
    ))}</div></fieldset>
  )
  const assets = (label: string, field: 'sell' | 'buy', value?: string) => (
    <label className="field">{label}<select className="input" value={value} onChange={(event) => set({ [field]: event.target.value })}>{here.map((a) => <option key={a.symbol}>{a.symbol}</option>)}</select></label>
  )
  return (
    <form className="ticket" data-step="ticket" onSubmit={(event) => ask(false, event)}>
      <label className="field">Settle from<select className="input" value={wallet.id} onChange={(event) => set({ walletId: event.target.value, sell: '', buy: '' })}>{v.wallets.map((w) => <option key={w.id} value={w.id}>{w.label} ({short(w.address)}, {w.chain})</option>)}</select></label>
      {pills('type', 'Order type', [['market', 'Market'], ['limit', 'Limit']], t.type, (type) => set({ type }))}
      <div className="row">{assets('Sell asset', 'sell', sell?.symbol)}<label className="field">Amount to sell<input className="input" type="text" inputMode="decimal" autoComplete="off" value={t.amount} onChange={(event) => set({ amount: event.target.value })} style={{ textAlign: 'right' }} />
        {sell && <small className="muted">At most {money(sell.cap, 0)} {sell.symbol} per order.</small>}</label></div>
      <div className="row">{assets('Buy asset', 'buy', buy?.symbol)}
        {t.type === 'limit' ? <label className="field">Limit price ({buy?.symbol} per {sell?.symbol})<input className="input" type="text" inputMode="decimal" autoComplete="off" value={t.limitPrice} onChange={(event) => set({ limitPrice: event.target.value })} style={{ textAlign: 'right' }} aria-describedby="limit-range" />
          <small id="limit-range" className="muted">Within 20% of the live quote.</small></label>
          : <label className="field">Slippage (%)<input className="input" type="text" inputMode="decimal" autoComplete="off" value={t.slippage} onChange={(event) => set({ slippage: event.target.value })} style={{ textAlign: 'right' }} /><small className="muted">At most {v.slippage.max / 100}%.</small></label>}</div>
      <label className="field">Valid after signing<select className="input" value={t.validFor} onChange={(event) => set({ validFor: Number(event.target.value) })}>{v.validity.map((s) => <option key={s} value={s}>{s < 3600 ? `${s / 60} minutes` : `${s / 3600} hours`}</option>)}</select></label>
      {failed}
      <button className="btn primary" type="submit" disabled={busy}><Icon name="eye" />Review order</button>
      <p className="fine"><Icon name="info" size={16} />Nothing is signed at this step. The review asks the orderbook for a live quote.</p>
    </form>
  )
}

// The record of one order: who prepared it and when, its terms, who decided, the signing link, and what the orderbook did.
function OrderRecord({ o, v, onClose, onSignedOut }: { o: Order; v: DeskView; onClose: () => void; onSignedOut: () => void }) {
  const [link, setLink] = useState('')
  const [problem, setProblem] = useState('')
  const decided = o.state === 'Cancelled' && !o.decidedBy ? `Cancelled by its preparer${o.decidedAt ? ` on ${stamp(o.decidedAt)}` : ''}` : o.decidedBy && o.decidedAt ? `${o.state === 'Refused' && !o.uid ? 'Refused' : 'Approved'} by ${o.decidedBy} on ${stamp(o.decidedAt)}` : o.state === 'Expired' ? 'Nobody decided it within 7 days' : 'Not decided yet'
  const purpose = o.state === 'Approved: waiting for signature' && !o.uid ? 'sign' : o.state === 'Open' ? 'cancel' : null
  async function give() {
    const out = await sensitive<{ link: string; error?: string }>(`/api/desk/orders/${o.id}/link`, { purpose }).catch(() => null)
    if (out?.status === 401) return onSignedOut()
    setProblem(!out ? CANCELLED : out.status === 200 ? '' : say(out.data))
    setLink(out?.status === 200 ? out.data.link : '')
  }
  return (
    <section className="panel sec" id="record" aria-label={`Record of ${o.ref}`}>
      <div className="rp-top"><b className="mono">{o.ref}</b><Status>{o.state}</Status><button className="ib" type="button" aria-label="Close the record" onClick={onClose}><Icon name="x" /></button></div>
      <p>{orderWords(o)}</p>
      <dl className="kv">
        <dt>Prepared by</dt><dd>{`${o.preparer} (${ROLE[o.preparerRole] ?? o.preparerRole}) on ${stamp(o.at)}`}</dd>
        <TermsFacts o={o} />
        <dt>Decided</dt><dd>{decided}</dd>
        {o.signUntil && <><dt>Sign before</dt><dd>{stamp(o.signUntil)}</dd></>}
        {o.uid && <><dt>Order id</dt><dd className="mono">{o.uid}</dd></>}
        {o.sold && <><dt>Executed</dt><dd>{o.sold} sold, {o.bought} bought (atoms)</dd></>}
        {o.tx && <><dt>Transaction</dt><dd className="mono">{o.tx}</dd></>}
      </dl>
      {purpose && v.maySign && (
        <div className="stack">
          <p className="note"><Icon name="info" /><span className="grow">{purpose === 'sign' ? 'The wallet signs this order on the signing page. Give the link to the people who hold the wallet, by a channel you trust. It works once.' : 'The wallet cancels this order on the signing page. The link works once.'}</span></p>
          <div className="acts"><button className="btn primary md" type="button" onClick={give}><Icon name="key-round" size={16} />{purpose === 'sign' ? 'Signing link' : 'Cancel link'}</button></div>
          {link && <label className="field">Link for the wallet<input className="input mono" readOnly value={link} onFocus={(event) => event.target.select()} /></label>}
        </div>
      )}
      {problem && <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{problem}</span></p>}
    </section>
  )
}

export function Desk({ kind, onSignedOut }: { kind: string; onSignedOut: () => void }) {
  return (
    <>
      <header className="ph"><div><span className="cap eyebrow">Desk</span><h1 className="h-page">Prepare, approve, <em>then sign</em>.</h1><p className="lede">Prepare an order on a live quote, then a second person approves, then your wallet signs.</p></div></header>
      {kind === 'institution' ? <InstitutionDesk onSignedOut={onSignedOut} /> : (
        <div className="panel"><div className="stack" style={{ alignItems: 'flex-start' }}><Tile name="landmark" /><h2 className="h-panel">The desk is for institutions.</h2><p className="muted">Partners integrate the swap in their own product. Your figures are in Overview.</p>
          <div className="acts"><a className="btn primary md" href="/#/overview"><Icon name="layout-dashboard" size={16} />Go to Overview</a></div></div></div>
      )}
    </>
  )
}

function InstitutionDesk({ onSignedOut }: { onSignedOut: () => void }) {
  const { view: v, problem, load } = useView<DeskView>('/api/desk', onSignedOut)
  const [picked, setPicked] = useState('')
  const [failed, setFailed] = useState('')
  if (!v) return problem ? <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{problem}</span></p> : null
  const record = v.orders.find((o) => o.id === picked)
  async function cancel(o: Order) {
    const out = await api<{ error?: string }>(`/api/approvals/${o.id}/cancel`, {})
    if (out.status === 401) return onSignedOut()
    setFailed(out.status === 200 ? '' : say(out.data))
    await load()
  }
  return (
    <>
      <p className="note dk-s"><Icon name="info" /><span className="grow"><b>Use a larger screen.</b> The desk needs room for the ticket. The blotter, the records and approvals work at this size.</span></p>
      <div className="desk dk-b">
        <section className="panel"><h2 className="cap">Order ticket</h2><TicketForm v={v} onSent={load} /></section>
        <div className="stack">
          <Section icon="list-checks" title="Permitted assets" hint="Each is listed on a chain where two independent sources agree on its address." action={<Export table="assets" />}>
            <Table head={['Asset', 'Chain', 'Most per order']} rows={v.assets.map((a) => [<><b>{a.symbol}</b><small className="mono">{short(a.token)}</small></>, a.chain, money(a.cap, 0)])} />
          </Section>
          <ol className="stats flow">
            <li className="c"><Tile name="pencil" /><div><span className="cap">Step 1</span><b>Prepare</b><p>A Trader fills the ticket and reviews the live quote.</p></div></li>
            <li className="c"><Tile name="users" /><div><span className="cap">Step 2</span><b>Approve</b><p>A second person approves under Approvals, with a passkey.</p></div></li>
            <li className="c"><Tile name="key-round" /><div><span className="cap">Step 3</span><b>Sign in wallet</b><p>The Safe owners or your custodian sign on the signing page. Ophis cannot.</p></div></li>
          </ol>
        </div>
      </div>
      <Section icon="scroll-text" title="Order blotter" hint="Your orders, newest first, with their state. Select an order to open its record." action={<Export table="orders" />}>
        {failed && <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{failed}</span></p>}
        {v.orders.length ? <Table head={['Order', 'Type', 'Sell', 'Buy', 'Chain', 'Status', 'Actions']} rows={v.orders.map((o) => [
          orderCell(o, (x) => setPicked(x.id)), o.terms.type === 'limit' ? 'Limit' : 'Market', o.words.sell, o.words.buy, o.words.chain, <Status>{o.state}</Status>,
          <>
            <button className="ib" type="button" aria-label={`Open the record of ${o.ref}`} title="Record" onClick={() => setPicked(o.id)}><Icon name="file-text" /></button>
            {o.mine && o.open && <button className="ib" type="button" aria-label={`Cancel ${o.ref}`} title="Cancel order" onClick={() => cancel(o)}><Icon name="ban" /></button>}
          </>,
        ])} /> : <p className="muted">No order yet.</p>}
      </Section>
      {record && <OrderRecord o={record} v={v} onClose={() => setPicked('')} onSignedOut={onSignedOut} />}
    </>
  )
}
