// Demo mode, institutions only: the figures of Overview and Desk, and the arithmetic of a demo order. A partner's figures are live (partner.ts). Fixed example data taken from the
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
export const ORDER_LIMIT_EUR = 5_000_000n // per order, at the reference price
export const MAX_OPEN_ORDERS = 20 // orders that wait for approval, per organisation
export const ORDERS_PER_HOUR = 30 // orders one member files in an hour: preparing and cancelling in a loop fills no table
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
export interface Order { ticket: Ticket; wallet: string; address: string; checks: string[]; estimate: Estimate }
/** The checks an order passed. The data module makes them inside the commit that files it; the ticket checks are quote() below. */
export const CHECKS = [
  'The preparer is an active Trader, Owner or Admin',
  'The organisation is an active institution and not in quarantine',
  'The wallet is linked to this organisation',
  'Both assets are permitted, and they differ',
  'The chain is Optimism or Unichain',
  `The amount is above zero and within ${shown(ORDER_LIMIT_EUR * E, 2).replace(/\B(?=(\d{3})+\.)/g, ',')} EUR per order, at the reference price and at the limit price`,
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
  const priced = type === 'limit' ? (sell === 'ETH' ? sell : buy) : null
  const at = (asset: Asset) => (asset === priced ? limit! : price(asset))
  const volume = (units * at(sell)) / E
  // The limit per order holds at the reference price and at the order's own price: a limit price moves the volume.
  if ((units * price(sell)) / E > ORDER_LIMIT_EUR * E || volume > ORDER_LIMIT_EUR * E) return 'over_limit'
  const fee = bps(volume, FEE_BPS)
  return {
    ticket: { type, sell, buy, amount: amount as string, limitPrice: type === 'limit' ? (limitPrice as string) : null, chainId, walletId },
    estimate: {
      received: shown(((volume - fee) * E) / at(buy), Math.min(ASSETS[buy].decimals, 8)), volumeEur: shown(volume, 2),
      feeBps: shown(FEE_BPS * E, 2), feeEur: shown(fee, 2), totalEur: shown(fee, 2), priced,
    },
  }
}
/**
 * The order as it is stored and approved: the ticket and the estimate of quote(), the wallet's name and address (two
 * wallets may share a name), the checks. judge() refuses any other form.
 */
export const built = (quoted: Exclude<ReturnType<typeof quote>, string>, wallet: string, address: string): Order => ({ ...quoted, wallet, address, checks: CHECKS })
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
  return { ...o, at: Date.parse(o.at), tx: o.tx ?? null, ticket: q.ticket, wallet: HOLDINGS[1].wallet, address: HOLDINGS[1].address, estimate: q.estimate }
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

// ---- CSV: the tables behind every "Export CSV" button. The router adds the column source = demo to each row. ----
type Table = [head: string[], rows: unknown[][]]
const orderRow = (o: { ref: string; at: number; state: string; ticket: Ticket; wallet: string; address: string; estimate: Estimate }) =>
  [o.ref, new Date(o.at).toISOString(), o.ticket.type, o.ticket.sell, o.ticket.amount, o.ticket.buy, o.estimate.received, o.ticket.limitPrice ?? '', CHAINS[o.ticket.chainId], o.wallet, o.address, o.estimate.volumeEur, o.estimate.feeEur, o.state]
/** The tables an institution can export; `own` are its own orders, shown before the examples. */
export function tables(own: Parameters<typeof orderRow>[0][]): Record<string, Table> {
  const i = institution()
  return {
    balances: [['Wallet', 'Address', 'Chain', 'Asset', 'Balance', 'Value (EUR)'], i.balances.flatMap((w) => w.rows.map((r) => [w.wallet, w.address, w.chain, r.asset, r.balance, r.valueEur]))],
    orders: [['Order', 'Prepared at', 'Type', 'Sell', 'Amount', 'Buy', 'Estimate received', 'Limit price (EUR)', 'Chain', 'Wallet', 'Wallet address', 'Volume (EUR)', 'Fee (EUR)', 'Status'], [...own, ...i.examples].map(orderRow)],
    statement: [['Month', 'Trades', 'Volume (EUR)', 'Fee (bps)', 'Fee (EUR)'], i.months.map((m) => [m.month, m.trades, m.volumeEur, m.feeBps, m.feeEur])],
    assets: [['Asset', 'Issuer', 'Status', 'Reference price (EUR)'], desk().assets.map((a) => [a.symbol, a.issuer, a.status, a.eur])],
  }
}
