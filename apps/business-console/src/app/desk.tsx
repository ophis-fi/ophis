// Overview and Desk. An institution: demo mode, the figures are the server's examples (src/server/demo.ts). What is
// real there: the orders an institution prepares (two-person requests), their state, and who may do what.
// A partner: live figures from the Ophis rebate service, checked and rebuilt by the server (src/server/partner.ts).
// No order is sent, signed or executed, and this file holds no price: every estimate is the server's.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, CANCELLED, capital, Icon, ROLE, save, say, sensitive, Section, stamp, Status, Tile } from './ui.tsx'

interface Ticket { type: 'market' | 'limit'; sell: string; buy: string; amount: string; limitPrice: string | null; chainId: number; walletId: string }
interface Estimate { received: string; volumeEur: string; feeBps: string; feeEur: string; totalEur: string; priced: string | null }
export interface OrderBody { ticket: Ticket; wallet: string; address?: string; estimate: Estimate; checks?: string[] }
// A row of the blotter: an order of this organisation (it has an id), or an example row (it has none).
interface Order extends OrderBody { id?: string; ref: string; at: number; state: string; open?: boolean; mine?: boolean; preparer?: string; preparerRole?: string; decidedBy?: string | null; decidedAt?: number | null; tx?: string | null }
interface Institution {
  kind: 'institution'; waiting: number; asOf: string; totalEur: string
  balances: { wallet: string; address: string; chain: string; total: string; rows: { asset: string; balance: string; valueEur: string }[] }[]
  months: { month: string; trades: number; volumeEur: string; feeBps: string; feeEur: string }[]
  orders: Order[]; examples: Order[]
}
// A partner's figures: live, or the plain reason why there are none. Numbers are USD or WETH amounts of the rebate service.
interface PartnerWallet {
  wallet: string; label: string; chain: string
  // null: a contract wallet whose chain the rebate service has not confirmed; no figure of it was read.
  fees: null | { shareUsd: number; carriedUsd: number; owedUsd: number; pendingTrades: number; paidWeth: number; trades: number; months: { month: string; status: string; owedUsd: number; owedWeth: number; carriedUsd: number }[] }
}
interface Partner { kind: 'partner'; waiting: number; figures: { state: 'not_connected' | 'no_wallet' | 'figures_unavailable' | 'figures_rate' } | { state: 'live'; asOf: string; leftOut: number; wallets: PartnerWallet[] } }
interface DeskView {
  assets: { symbol: string; decimals: number; eur: string; issuer: string; status: string; limitLow: string; limitHigh: string }[]; chains: { id: number; name: string }[]
  wallets: { id: string; label: string; address: string; chain: string }[]; limitEur: string; mayPrepare: boolean; orders: Order[]; examples: Order[]
}

const CHAIN: Record<number, string> = { 10: 'Optimism', 130: 'Unichain' }
/** A decimal string of the server with thousands separators and `dp` decimals (cut). Text only: no number is made of it. */
export function money(text: string, dp = 2) {
  const [whole, part = ''] = text.split('.')
  return `${whole.replace(/\B(?=(\d{3})+$)/g, ',')}${dp ? `.${part.padEnd(dp, '0').slice(0, dp)}` : ''}`
}
const places = (asset: string) => (asset === 'ETH' ? 4 : 2)
const qty = (amount: string, asset: string) => `${money(amount, places(asset))} ${asset}`
const count = (n: number) => money(String(n), 0)
// What a member typed (an amount, a limit price) is shown whole: every decimal of it, never cut.
const exact = (text: string, dp = 2) => money(text, Math.max(dp, text.split('.')[1]?.length ?? 0))
const sold = (t: Ticket) => `${exact(t.amount, places(t.sell))} ${t.sell}`
const short = (address: string) => (address.length > 13 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address)
/** An order in words, as the Approvals list and the record say it. */
export const orderWords = ({ ticket, wallet, address, estimate }: OrderBody) =>
  `Sell ${sold(ticket)} for ${ticket.buy}, ${ticket.type}${ticket.limitPrice ? ` at ${exact(ticket.limitPrice)} EUR per ${estimate.priced}` : ''}, ${CHAIN[ticket.chainId] ?? `chain ${ticket.chainId}`}, from ${wallet}${address ? ` (${short(address)})` : ''}`

const Banner = () => <p className="note warn demo" role="note"><Icon name="info" /><span className="grow"><b>Demo data.</b> No order is sent and no funds move. Figures are examples.</span></p>
const EXAMPLE = 'Example figures. The real cost of an order is shown before it is signed.'

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
  <>
    {pick ? <button className="link mono" type="button" onClick={() => pick(o)}>{o.ref}</button> : <span className="mono">{o.ref}</span>}
    {!o.id && <Status>Example</Status>}<small>{stamp(o.at)}</small>
  </>
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
        <Section icon="history" title="Recent orders" hint="Your own orders first, with their real state. Then example rows." action={<div className="acts"><Export table="orders" /><a className="btn ghost sm" href="/#/desk">All orders</a></div>}>
          <Table head={['Order', 'Sell, buy', 'Status']} rows={[...v.orders, ...v.examples].slice(0, 8).map((o) => [orderCell(o), <>{sold(o.ticket)}<small>for {o.ticket.buy}</small></>, <Status>{o.state}</Status>])} />
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

function PartnerWalletFigures({ w }: { w: PartnerWallet }) {
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
        {f.state === 'live' && <div className="acts"><Export table="months" size="md" label="Fee months CSV" /></div>}
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
          {f.wallets.map((w) => <PartnerWalletFigures key={w.wallet} w={w} />)}
        </>
      )}
      {v.waiting > 0 && <p className="note"><Icon name="users" /><span className="grow"><b data-waiting>{v.waiting}</b> {v.waiting === 1 ? 'request waits' : 'requests wait'} for your approval. <a className="link" href="/#/organisation">Open approvals</a></span></p>}
    </>
  )
}

// ---- the desk ----
const Cost = ({ e }: { e: Estimate }) => (
  <>
    <Table head={['Fee line', 'bps', 'EUR']} rows={[['Fee, of the volume', e.feeBps, money(e.feeEur)]]} foot={['Total (estimate)', e.feeBps, money(e.totalEur)]} />
    <p className="fine"><Icon name="info" size={16} />{EXAMPLE}</p>
  </>
)
const TicketFacts = ({ o }: { o: OrderBody }) => (
  <>
    <dt>Order type</dt><dd>{o.ticket.type === 'limit' ? `Limit, at ${exact(o.ticket.limitPrice ?? '')} EUR per ${o.estimate.priced}` : 'Market'}</dd>
    <dt>You sell</dt><dd>{sold(o.ticket)}</dd>
    <dt>You buy (estimate)</dt><dd>{qty(o.estimate.received, o.ticket.buy)}</dd>
    <dt>Volume</dt><dd>{money(o.estimate.volumeEur)} EUR</dd>
    <dt>Settle from</dt><dd>{o.wallet}{o.address && <>, <span className="mono">{o.address}</span></>}</dd>
    <dt>Chain</dt><dd>{CHAIN[o.ticket.chainId]}</dd>
  </>
)

function TicketForm({ v, onSent }: { v: DeskView; onSent: () => Promise<void> }) {
  const [t, setT] = useState({ type: 'market', sell: 'EURC', buy: 'ETH', amount: '250000', limitPrice: '2940', chainId: 10, walletId: v.wallets[0]?.id ?? '' })
  const [review, setReview] = useState<OrderBody>()
  const [sent, setSent] = useState(false)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (change: Partial<typeof t>) => setT({ ...t, ...change })
  const priced = t.sell === 'ETH' || t.buy === 'ETH' ? 'ETH' : t.buy
  const range = v.assets.find((a) => a.symbol === priced)
  async function ask(send: boolean, event?: FormEvent) {
    event?.preventDefault()
    setBusy(true)
    const { limitPrice, ...rest } = t
    // The estimate needs no passkey. Sending does: when the last check is older than 5 minutes, the passkey is asked for here.
    const out = await (send ? sensitive : api)<OrderBody & { error?: string }>('/api/desk/orders', { ...rest, amount: t.amount.trim(), ...(t.type === 'limit' && { limitPrice: limitPrice.trim() }), send }).catch(() => null)
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
  if (v.wallets.length === 0) return <p className="note warn"><Icon name="wallet" /><span className="grow"><b>No wallet is linked.</b> An order settles from a linked wallet of the organisation. <a className="link" href="/#/organisation">Link one under Organisation</a>.</span></p>
  if (sent && review) {
    return (
      <div className="ticket" data-step="sent">
        <p className="note ok" role="status"><Icon name="circle-check" /><span className="grow"><b>Sent for approval.</b> {orderWords(review)}. A different member with a key role approves or refuses it under Approvals. Nothing is sent to a market.</span></p>
        <div className="acts"><a className="btn ghost md" href="/#/organisation"><Icon name="users" size={16} />Open approvals</a><button className="btn primary md" type="button" onClick={() => (setSent(false), setReview(undefined))}><Icon name="pencil" size={16} />New order</button></div>
      </div>
    )
  }
  if (review) {
    return (
      <div className="ticket" data-step="review">
        <h3 className="h-card">Review order</h3>
        <dl className="kv"><TicketFacts o={review} /></dl>
        <Cost e={review.estimate} />
        {failed}
        <div className="acts"><button className="btn ghost md" type="button" onClick={() => setReview(undefined)}>Back to the ticket</button><button className="btn primary md" type="button" disabled={busy} onClick={() => ask(true)}><Icon name="users" size={16} />Send for approval</button></div>
        <p className="fine"><Icon name="info" size={16} />Nothing is signed at this step. Sending asks for your passkey. A second person then approves it, with a passkey.</p>
      </div>
    )
  }
  const pills = (name: string, legend: string, options: [value: string | number, label: string][], value: string | number, pick: (value: string) => void, off: string[] = []) => (
    <fieldset className="field"><legend>{legend}</legend><div className="pills">{options.map(([option, label]) => (
      <label className="pill" key={option}><input type="radio" name={name} value={option} checked={value === option} disabled={off.includes(label)} onChange={(event) => pick(event.target.value)} />{label}</label>
    ))}</div>{off.length > 0 && <small className="muted">No wallet is linked on {off.join(' or ')}.</small>}</fieldset>
  )
  // The server refuses an order whose wallet is not linked on its chain (wallet_chain): such a chain is switched off here, and the ticket says why.
  const unlinked = v.chains.map((c) => c.name).filter((chain) => !v.wallets.some((w) => w.chain === chain))
  const assets = (label: string, field: 'sell' | 'buy') => (
    <label className="field">{label}<select className="input" value={t[field]} onChange={(event) => set({ [field]: event.target.value })}>{v.assets.map((a) => <option key={a.symbol}>{a.symbol}</option>)}</select></label>
  )
  return (
    <form className="ticket" data-step="ticket" onSubmit={(event) => ask(false, event)}>
      {pills('type', 'Order type', [['market', 'Market'], ['limit', 'Limit']], t.type, (type) => set({ type }))}
      <div className="row">{assets('Sell asset', 'sell')}<label className="field">Amount to sell<input className="input" type="text" inputMode="decimal" autoComplete="off" value={t.amount} onChange={(event) => set({ amount: event.target.value })} style={{ textAlign: 'right' }} /></label></div>
      <div className="row">{assets('Buy asset', 'buy')}
        {t.type === 'limit' && <label className="field">Limit price (EUR per {priced})<input className="input" type="text" inputMode="decimal" autoComplete="off" value={t.limitPrice} onChange={(event) => set({ limitPrice: event.target.value })} style={{ textAlign: 'right' }} aria-describedby="limit-range" />
          {range && <small id="limit-range" className="muted">Allowed range: {exact(range.limitLow)} to {exact(range.limitHigh)} EUR, within 20% of the reference price.</small>}</label>}</div>
      {pills('chain', 'Chain', v.chains.map((c) => [c.id, c.name]), t.chainId, (id) => set({ chainId: Number(id) }), unlinked)}
      <label className="field">Settle from<select className="input" value={t.walletId} onChange={(event) => set({ walletId: event.target.value })}>{v.wallets.map((w) => <option key={w.id} value={w.id}>{w.label} ({short(w.address)}, {w.chain})</option>)}</select></label>
      {failed}
      <button className="btn primary" type="submit" disabled={busy}><Icon name="eye" />Review order</button>
      <p className="fine"><Icon name="info" size={16} />Nothing is signed at this step. Limit of {money(v.limitEur)} EUR per order.</p>
    </form>
  )
}

// The record of one order: who prepared it and when, the ticket, the checks, the estimate, who decided, and that nothing was executed.
function OrderRecord({ o, onClose }: { o: Order; onClose: () => void }) {
  const decided = o.state === 'Cancelled' ? `Cancelled by its preparer${o.decidedAt ? ` on ${stamp(o.decidedAt)}` : ''}` : o.decidedBy && o.decidedAt ? `${o.state === 'Refused' ? 'Refused' : 'Approved'} by ${o.decidedBy} on ${stamp(o.decidedAt)}` : o.state === 'Expired' ? 'Nobody decided it within 7 days' : 'Not decided yet'
  return (
    <section className="panel sec" id="record" aria-label={`Record of ${o.ref}`}>
      <div className="rp-top"><b className="mono">{o.ref}</b><Status>{o.state}</Status>{!o.id && <Status>Example</Status>}<button className="ib" type="button" aria-label="Close the record" onClick={onClose}><Icon name="x" /></button></div>
      <p>{orderWords(o)}</p>
      <dl className="kv">
        <dt>Prepared by</dt><dd>{o.id ? `${o.preparer} (${ROLE[o.preparerRole ?? ''] ?? o.preparerRole}) on ${stamp(o.at)}` : `Example row, dated ${stamp(o.at)}`}</dd>
        <TicketFacts o={o} />
        <dt>Decided</dt><dd>{o.id ? decided : 'Example row: no decision is recorded'}</dd>
      </dl>
      <p className="note"><Icon name="info" /><span className="grow">Execution: none, demo</span></p>
      {o.checks && <div><h3 className="h-card">Checks passed when it was prepared</h3><ul className="checks">{o.checks.map((line) => <li key={line}><Icon name="check" size={16} />{line}</li>)}</ul></div>}
      <div><h3 className="h-card">Estimate</h3><Cost e={o.estimate} /></div>
    </section>
  )
}

export function Desk({ kind, onSignedOut }: { kind: string; onSignedOut: () => void }) {
  return (
    <>
      <header className="ph"><div><span className="cap eyebrow">Desk <Status>Demo</Status></span><h1 className="h-page">Prepare, approve, <em>then sign</em>.</h1><p className="lede">Prepare an order, review the cost, then a second person approves. Amounts in EUR.</p></div></header>
      <Banner />
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
  const rows = [...v.orders, ...v.examples]
  const record = rows.find((o) => (o.id ?? o.ref) === picked)
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
          <Section icon="list-checks" title="Permitted assets" hint="Illustrative. Each token is checked against the ESMA register before launch" action={<div className="acts"><Status>Illustrative</Status><Export table="assets" /></div>}>
            <Table head={['Asset', 'Issuer', 'Status', 'Reference price (EUR)']} rows={v.assets.map((a) => [<b>{a.symbol}</b>, a.issuer, a.status, money(a.eur)])} />
          </Section>
          <ol className="stats flow">
            <li className="c"><Tile name="pencil" /><div><span className="cap">Step 1</span><b>Prepare</b><p>A Trader fills the ticket and reviews the cost.</p></div></li>
            <li className="c"><Tile name="users" /><div><span className="cap">Step 2</span><b>Approve</b><p>A second person approves under Approvals, with a passkey.</p></div></li>
            <li className="c"><Tile name="key-round" /><div><span className="cap">Step 3</span><b>Sign in wallet</b><p>Signing in the wallet is not part of this demo. The Safe owners or your custodian sign. Ophis cannot.</p></div></li>
          </ol>
        </div>
      </div>
      <Section icon="scroll-text" title="Order blotter" hint="Your own orders first, with their real state. Then example rows. Select an order to open its record." action={<Export table="orders" />}>
        {failed && <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{failed}</span></p>}
        <Table head={['Order', 'Type', 'Sell', 'Buy', 'Chain', 'Status', 'Actions']} rows={rows.map((o) => [
          orderCell(o, (x) => setPicked(x.id ?? x.ref)), <>{o.ticket.type === 'limit' ? 'Limit' : 'Market'}{o.ticket.limitPrice && <small>at {exact(o.ticket.limitPrice)}</small>}</>,
          sold(o.ticket), <><span className="muted">est.</span> {qty(o.estimate.received, o.ticket.buy)}</>, CHAIN[o.ticket.chainId], <Status>{o.state}</Status>,
          <>
            <button className="ib" type="button" aria-label={`Open the record of ${o.ref}`} title="Record" onClick={() => setPicked(o.id ?? o.ref)}><Icon name="file-text" /></button>
            {o.mine && o.open && <button className="ib" type="button" aria-label={`Cancel ${o.ref}`} title="Cancel order" onClick={() => cancel(o)}><Icon name="ban" /></button>}
          </>,
        ])} />
      </Section>
      {record && <OrderRecord o={record} onClose={() => setPicked('')} />}
    </>
  )
}
