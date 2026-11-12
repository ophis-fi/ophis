// Demo mode: the figures of Overview and Desk, and the arithmetic of a demo order. Fixed example data taken from the
// mockup. No chain and no market is read, no order is sent, signed or executed. It imports nothing and reads no row.
// Every total is computed from the rows below, never typed a second time.

/** The day the example figures stand for. */
export const DEMO_DAY = '2026-11-10'
export const CHAINS: Record<number, string> = { 10: 'Optimism', 130: 'Unichain' }
// The permitted assets, and the server's reference prices in EUR. Illustrative: each token is checked against the ESMA register before launch.
export const ASSETS = {
  ETH: { decimals: 18, eur: '2950', issuer: 'No issuer', status: 'Native asset' },
  USDC: { decimals: 6, eur: '0.92', issuer: 'Circle Internet Financial Europe', status: 'E-money token' },
  EURC: { decimals: 6, eur: '1', issuer: 'Circle Internet Financial Europe', status: 'E-money token' },
  EURe: { decimals: 18, eur: '1', issuer: 'Monerium', status: 'E-money token' },
  EURCV: { decimals: 18, eur: '1', issuer: 'Societe Generale-FORGE', status: 'E-money token' },
} as const
export type Asset = keyof typeof ASSETS
const isAsset = (value: unknown): value is Asset => typeof value === 'string' && Object.hasOwn(ASSETS, value)
const FEE_BPS = 1n // of the volume of an institution's order
const PARTNER_BPS = 25n // the example partner's own fee, which the partner sets
export const ORDER_LIMIT_EUR = 5_000_000n // per order, at the reference price
export const MAX_OPEN_ORDERS = 20 // orders that wait for approval, per organisation
export const PREPARERS = ['owner', 'admin', 'trader'] as const

// ---- money: integers only. A decimal string becomes a bigint with 18 decimals; nothing here is a float. ----
const E = 10n ** 18n
/** A plain decimal string, as 18-decimal fixed point. Null: not a plain decimal, over 15 digits, or more decimals than `decimals`. */
export function fixed(text: unknown, decimals: number) {
  const m = typeof text === 'string' ? /^(0|[1-9]\d{0,14})(?:\.(\d{1,18}))?$/.exec(text) : null
  if (!m || (m[2]?.length ?? 0) > decimals) return null
  return BigInt(m[1]) * E + BigInt((m[2] ?? '').padEnd(18, '0'))
}
/** Fixed point as a decimal string with `dp` decimals: cut, never rounded up. */
export function shown(value: bigint, dp: number) {
  const digits = (value / 10n ** BigInt(18 - dp)).toString().padStart(dp + 1, '0')
  return dp ? `${digits.slice(0, -dp)}.${digits.slice(-dp)}` : digits
}
const whole = (text: string) => fixed(text, 18)!
const price = (asset: Asset) => whole(ASSETS[asset].eur)
const bps = (value: bigint, rate: bigint) => (value * rate) / 10_000n
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n)

// ---- a demo order ----
export interface Ticket { type: 'market' | 'limit'; sell: Asset; buy: Asset; amount: string; limitPrice: string | null; chainId: number; walletId: string }
export interface Estimate { received: string; volumeEur: string; feeBps: string; feeEur: string; totalEur: string; priced: Asset | null }
/** What an approval of kind order.demo holds, and so what the checker's passkey covers. */
export interface Order { ticket: Ticket; wallet: string; checks: string[]; estimate: Estimate }
/** The checks an order passed. The data module makes them inside the commit that files it; the ticket checks are quote() below. */
export const CHECKS = [
  'The preparer is an active Trader, Owner or Admin',
  'The organisation is an active institution and not in quarantine',
  'The wallet is linked to this organisation',
  'Both assets are permitted, and they differ',
  'The chain is Optimism or Unichain',
  `The amount is above zero and within ${shown(ORDER_LIMIT_EUR * E, 2).replace(/\B(?=(\d{3})+\.)/g, ',')} EUR per order, at the reference price`,
  `Fewer than ${MAX_OPEN_ORDERS} orders wait for approval`,
]
/**
 * The ticket checks and the estimate, from this server's reference prices. Whatever else the caller sent (a price,
 * a fee, an estimate) is not read. A limit price is EUR per unit of ETH when ETH is one side, else of the asset bought.
 * Returns the refusal, or the ticket (known fields only) with its estimate.
 */
export function quote(body: Record<string, unknown>): string | { ticket: Ticket; estimate: Estimate } {
  const { type, sell, buy, amount, chainId, walletId } = body
  const limitPrice = body.limitPrice ?? null
  if (type !== 'market' && type !== 'limit') return 'type_invalid'
  if (!isAsset(sell) || !isAsset(buy)) return 'asset_not_permitted'
  if (sell === buy) return 'same_asset'
  if (typeof chainId !== 'number' || !Object.hasOwn(CHAINS, chainId)) return 'chain_not_allowed'
  if (typeof walletId !== 'string') return 'wallet_not_linked' // whether it is a linked wallet of the organisation is read from the rows
  const units = fixed(amount, ASSETS[sell].decimals)
  if (units === null || units <= 0n) return 'amount_invalid'
  const limit = type === 'limit' ? fixed(limitPrice, 6) : null
  if (type === 'limit' ? limit === null || limit <= 0n : limitPrice !== null) return 'limit_price_invalid'
  if ((units * price(sell)) / E > ORDER_LIMIT_EUR * E) return 'over_limit'
  const priced = type === 'limit' ? (sell === 'ETH' ? sell : buy) : null
  const at = (asset: Asset) => (asset === priced ? limit! : price(asset))
  const volume = (units * at(sell)) / E
  const fee = bps(volume, FEE_BPS)
  return {
    ticket: { type, sell, buy, amount: amount as string, limitPrice: type === 'limit' ? (limitPrice as string) : null, chainId, walletId },
    estimate: {
      received: shown(((volume - fee) * E) / at(buy), Math.min(ASSETS[buy].decimals, 8)), volumeEur: shown(volume, 2),
      feeBps: shown(FEE_BPS * E, 2), feeEur: shown(fee, 2), totalEur: shown(fee, 2), priced,
    },
  }
}
/** What the blotter says of an approval row of kind order.demo. An approved order is final: nothing is sent. */
export const orderState = (state: string, open: boolean) =>
  state === 'pending' ? (open ? 'Pending approval' : 'Expired') : state === 'applied' ? 'Approved. Not sent: demo' : state === 'rejected' ? 'Refused' : 'Cancelled'

// ---- institution: balances, past orders, monthly statement ----
const HOLDINGS: { wallet: string; address: string; chainId: number; rows: [Asset, string][] }[] = [
  { wallet: 'Treasury Safe', address: '0x7a3F...c91E', chainId: 10, rows: [['EURC', '4200000'], ['ETH', '310.5'], ['EURe', '1091200']] },
  { wallet: 'Operations Safe', address: '0x4b1D...08a2', chainId: 10, rows: [['USDC', '1850000'], ['EURC', '600000']] },
  { wallet: 'Custody account', address: '0xE2c9...5f37', chainId: 130, rows: [['EURC', '2500000'], ['ETH', '120']] },
]
const PAST: { ref: string; at: string; state: string; ticket: Omit<Ticket, 'walletId' | 'limitPrice'> & { limitPrice?: string }; tx?: string }[] = [
  { ref: 'ORD-2611-0142', at: '2026-11-10T09:14:22Z', state: 'Open', ticket: { type: 'limit', sell: 'EURC', buy: 'ETH', amount: '250000', limitPrice: '2940', chainId: 10 } },
  { ref: 'ORD-2611-0141', at: '2026-11-10T08:02:10Z', state: 'Pending approval', ticket: { type: 'market', sell: 'USDC', buy: 'EURC', amount: '1200000', chainId: 10 } },
  { ref: 'ORD-2611-0139', at: '2026-11-09T15:41:03Z', state: 'Filled', ticket: { type: 'market', sell: 'ETH', buy: 'USDC', amount: '85', chainId: 10 }, tx: '0x8c41...e2b9' },
  { ref: 'ORD-2611-0136', at: '2026-11-07T10:20:45Z', state: 'Filled', ticket: { type: 'market', sell: 'EURe', buy: 'EURC', amount: '500000', chainId: 130 }, tx: '0x27fa...6d13' },
  { ref: 'ORD-2611-0131', at: '2026-11-06T13:05:12Z', state: 'Expired', ticket: { type: 'limit', sell: 'ETH', buy: 'EURC', amount: '105', limitPrice: '3010', chainId: 10 } },
  { ref: 'ORD-2611-0127', at: '2026-11-05T09:48:30Z', state: 'Filled', ticket: { type: 'market', sell: 'USDC', buy: 'EURC', amount: '400000', chainId: 130 }, tx: '0xb90e...4a75' },
  { ref: 'ORD-2611-0124', at: '2026-11-04T16:12:09Z', state: 'Cancelled', ticket: { type: 'limit', sell: 'EURC', buy: 'ETH', amount: '150000', limitPrice: '2890', chainId: 10 } },
]
const MONTHS: [month: string, trades: number, volumeEur: string][] = [['2026-11, to date', 14, '17920000'], ['2026-10', 51, '63400000'], ['2026-09', 44, '52800000'], ['2026-08', 38, '41250000']]

/** The example orders, each with the estimate quote() gives its ticket. */
export const examples = () => PAST.map(({ ticket, ...o }) => {
  const q = quote({ ...ticket, walletId: '0'.repeat(32) }) as Exclude<ReturnType<typeof quote>, string>
  return { ...o, at: Date.parse(o.at), tx: o.tx ?? null, ticket: q.ticket, wallet: 'Operations Safe', estimate: q.estimate }
})
export function institution() {
  const balances = HOLDINGS.map((w) => {
    const rows = w.rows.map(([asset, balance]) => ({ asset, balance, value: (whole(balance) * price(asset)) / E }))
    return { wallet: w.wallet, address: w.address, chain: CHAINS[w.chainId], total: sum(rows.map((r) => r.value)), rows }
  })
  return {
    asOf: `${DEMO_DAY} 09:30:00Z`,
    totalEur: shown(sum(balances.map((w) => w.total)), 2),
    balances: balances.map((w) => ({ ...w, total: shown(w.total, 2), rows: w.rows.map((r) => ({ asset: r.asset, balance: r.balance, valueEur: shown(r.value, 2) })) })),
    months: MONTHS.map(([month, trades, volume]) => ({ month, trades, volumeEur: shown(whole(volume), 2), feeBps: shown(FEE_BPS * E, 2), feeEur: shown(bps(whole(volume), FEE_BPS), 2) })),
    examples: examples(),
  }
}
/** What the desk shows besides the organisation's own rows. */
export const desk = () => ({
  assets: (Object.keys(ASSETS) as Asset[]).map((symbol) => ({ symbol, ...ASSETS[symbol] })),
  chains: Object.entries(CHAINS).map(([id, name]) => ({ id: Number(id), name })),
  limitEur: shown(ORDER_LIMIT_EUR * E, 2), maxOpen: MAX_OPEN_ORDERS, checks: CHECKS, examples: examples(),
})

// ---- partner: only what the partner earns. No figure of Ophis's own fee is here, and a test keeps it so. ----
const FIRST_DAY = Date.UTC(2026, 9, 11)
const DAY_MS = 86_400_000
// Volume per day in thousands of USD, 30 days from 2026-10-11.
const DAYS = [800, 1412, 1811, 1365, 1740, 1613, 715, 907, 1374, 1703, 1414, 1439, 1722, 1074, 774, 1580, 1928, 2209, 1905, 1760, 1179, 767, 2187, 1701, 1582, 1566, 1743, 1145, 855, 2013]
const BY_CHAIN: [string, string][] = [['Optimism', '28588950'], ['Unichain', '15394050']]
const BY_TOKEN: [Asset, string][] = [['USDC', '19264554'], ['ETH', '11919393'], ['EURC', '6597450'], ['EURe', '4310334'], ['EURCV', '1891269']]
// Two volumes differ from the mockup by 2 USD, so that each fee is a whole number of cents and the column adds up to the total.
const CODES: [code: string, created: string, wallets: number, trades: number, volume: string][] = [
  ['NW-VAULTS', '2026-06-02', 512, 3846, '20232180'], ['NW-TREASURY', '2026-06-02', 148, 1204, '10555920'], ['NW-DAO-OPS', '2026-07-15', 96, 1611, '7477112'],
  ['NW-APP', '2026-08-21', 441, 2318, '3958468'], ['NW-PILOT', '2026-10-01', 87, 433, '1759320'],
]
const PAYOUT_TX = ['0xc07b...e5a1', '0x5d94...71e3', '0xa6c0...2f8d', '0x13e7...9b60', '0x8f2a...d41c'] // oldest week first
const ATTRIBUTED: [wallet: string, firstSeen: string, code: string, chain: string, trades: number, volume: string, lastTrade: string][] = [
  ['0x3fA2...9c1B', '2026-06-04', 'NW-VAULTS', 'Optimism', 212, '4812400', '2026-11-09 21:14:05Z'], ['0xB81e...44d0', '2026-06-11', 'NW-TREASURY', 'Optimism', 38, '3950000', '2026-11-09 16:02:51Z'],
  ['0x09Cd...a7F3', '2026-07-19', 'NW-DAO-OPS', 'Optimism', 141, '2204750', '2026-11-09 19:40:18Z'], ['0xD4f0...b2E8', '2026-09-02', 'NW-VAULTS', 'Unichain', 77, '1120900', '2026-11-08 11:27:33Z'],
  ['0x6e5B...13aa', '2026-08-23', 'NW-APP', 'Optimism', 96, '418320', '2026-11-09 22:58:40Z'], ['0x21aC...f590', '2026-09-30', 'NW-APP', 'Unichain', 54, '96480', '2026-11-09 07:15:02Z'],
  ['0x8C37...0e6D', '2026-10-03', 'NW-PILOT', 'Unichain', 19, '61200', '2026-11-07 13:44:29Z'], ['0xF7b9...5c42', '2026-10-28', 'NW-PILOT', 'Optimism', 6, '12750', '2026-11-06 09:03:57Z'],
]
const date = (time: number) => new Date(time).toISOString().slice(0, 10)
const split = (rows: [string, string][]) => {
  const total = sum(rows.map(([, v]) => whole(v)))
  return rows.map(([name, v]) => ({ name, volume: shown(whole(v), 2), share: shown((whole(v) * 100n * E) / total, 1) }))
}
export function partner() {
  const days = DAYS.map((thousands, i) => ({ time: FIRST_DAY + i * DAY_MS, volume: BigInt(thousands) * 1000n * E }))
  const volume = sum(days.map((d) => d.volume))
  const trades = CODES.reduce((n, c) => n + c[3], 0)
  // The ledger: the days of each week (Monday to Sunday) that are in the series. A week that ended before the demo day is paid.
  const weeks = new Map<number, typeof days>()
  for (const d of days) {
    const monday = d.time - ((new Date(d.time).getUTCDay() + 6) % 7) * DAY_MS
    weeks.set(monday, [...(weeks.get(monday) ?? []), d])
  }
  return {
    period: { from: date(days[0].time), to: date(days.at(-1)!.time) },
    volume: shown(volume, 2), feesEarned: shown(bps(volume, PARTNER_BPS), 2), feeBps: shown(PARTNER_BPS * E, 2),
    wallets: CODES.reduce((n, c) => n + c[2], 0), trades, averageTrade: shown(volume / BigInt(trades), 2),
    days: days.map((d) => ({ date: date(d.time), volume: shown(d.volume, 2), fees: shown(bps(d.volume, PARTNER_BPS), 2) })),
    chains: split(BY_CHAIN), tokens: split(BY_TOKEN),
    codes: CODES.map(([code, created, wallets, codeTrades, v]) => ({ code, created, wallets, trades: codeTrades, volume: shown(whole(v), 2), fee: shown(bps(whole(v), PARTNER_BPS), 2) })),
    payouts: [...weeks.entries()].map(([monday, of], i) => {
      const paid = monday + 7 * DAY_MS <= Date.parse(DEMO_DAY)
      return { from: date(of[0].time), to: date(of.at(-1)!.time), fees: shown(bps(sum(of.map((d) => d.volume)), PARTNER_BPS), 2), transaction: paid ? PAYOUT_TX[i] : null, paidAt: paid ? date(monday + 7 * DAY_MS) : null, status: paid ? 'Paid' : 'Accrued' }
    }).reverse(),
    attributed: ATTRIBUTED.map(([wallet, firstSeen, code, chain, walletTrades, v, lastTrade]) => ({ wallet, firstSeen, code, chain, trades: walletTrades, volume: shown(whole(v), 2), lastTrade })),
  }
}

// ---- CSV: the tables behind every "Export CSV" button. The router adds the column source = demo to each row. ----
type Table = [head: string[], rows: unknown[][]]
const orderRow = (o: { ref: string; at: number; state: string; ticket: Ticket; wallet: string; estimate: Estimate }) =>
  [o.ref, new Date(o.at).toISOString(), o.ticket.type, o.ticket.sell, o.ticket.amount, o.ticket.buy, o.estimate.received, o.ticket.limitPrice ?? '', CHAINS[o.ticket.chainId], o.wallet, o.estimate.volumeEur, o.estimate.feeEur, o.state]
/** The tables an organisation of this kind can export; `own` are its own orders, shown before the examples. */
export function tables(kind: string, own: Parameters<typeof orderRow>[0][]): Record<string, Table> {
  if (kind === 'partner') {
    const p = partner()
    return {
      daily: [['Date', 'Volume (USD)', 'Fees earned (USD)'], p.days.map((d) => [d.date, d.volume, d.fees])],
      codes: [['Code', 'Created', 'Wallets', 'Trades', 'Volume (USD)', 'Your fee (USD)'], p.codes.map((c) => [c.code, c.created, c.wallets, c.trades, c.volume, c.fee])],
      payouts: [['From', 'To', 'Fees (USD)', 'Transaction', 'Paid at', 'Status'], p.payouts.map((w) => [w.from, w.to, w.fees, w.transaction ?? '', w.paidAt ?? '', w.status])],
      wallets: [['Wallet', 'First seen', 'Code', 'Main chain', 'Trades', 'Volume (USD)', 'Last trade (UTC)'], p.attributed.map((w) => [w.wallet, w.firstSeen, w.code, w.chain, w.trades, w.volume, w.lastTrade])],
    }
  }
  const i = institution()
  return {
    balances: [['Wallet', 'Address', 'Chain', 'Asset', 'Balance', 'Value (EUR)'], i.balances.flatMap((w) => w.rows.map((r) => [w.wallet, w.address, w.chain, r.asset, r.balance, r.valueEur]))],
    orders: [['Order', 'Prepared at', 'Type', 'Sell', 'Amount', 'Buy', 'Estimate received', 'Limit price (EUR)', 'Chain', 'Wallet', 'Volume (EUR)', 'Fee (EUR)', 'Status'], [...own, ...i.examples].map(orderRow)],
    statement: [['Month', 'Trades', 'Volume (EUR)', 'Fee (bps)', 'Fee (EUR)'], i.months.map((m) => [m.month, m.trades, m.volumeEur, m.feeBps, m.feeEur])],
    assets: [['Asset', 'Issuer', 'Status', 'Reference price (EUR)'], desk().assets.map((a) => [a.symbol, a.issuer, a.status, a.eur])],
  }
}
