// Demo mode, institutions only: the example figures of the Overview (balances, monthly statement). The desk is real
// (orders.ts) and a partner's figures are live (partner.ts). Fixed example data taken from the mockup. It imports nothing and reads no row.
// Every total is computed from the rows below, never typed a second time.

/** The day the example figures stand for. */
export const DEMO_DAY = '2026-11-10'
export const CHAINS: Record<number, string> = { 10: 'Optimism', 130: 'Unichain' }
// The assets of the example balances, at example prices in EUR. The desk's assets are those of orders.ts.
export const ASSETS = {
  ETH: { decimals: 18, eur: '2950', issuer: 'No issuer', status: 'Native asset' },
  USDC: { decimals: 6, eur: '0.92', issuer: 'Circle Internet Financial Europe', status: 'E-money token' },
  EURC: { decimals: 6, eur: '1', issuer: 'Circle Internet Financial Europe', status: 'E-money token' },
  EURe: { decimals: 18, eur: '1', issuer: 'Monerium', status: 'E-money token' },
  EURCV: { decimals: 18, eur: '1', issuer: 'Societe Generale-FORGE', status: 'E-money token' },
} as const
export type Asset = keyof typeof ASSETS
const FEE_BPS = 1n // of the volume of an institution's order

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

// ---- institution: balances, monthly statement ----
const HOLDINGS: { wallet: string; address: string; chainId: number; rows: [Asset, string][] }[] = [
  { wallet: 'Treasury Safe', address: '0x7a3F...c91E', chainId: 10, rows: [['EURC', '4200000'], ['ETH', '310.5'], ['EURe', '1091200']] },
  { wallet: 'Operations Safe', address: '0x4b1D...08a2', chainId: 10, rows: [['USDC', '1850000'], ['EURC', '600000']] },
  { wallet: 'Custody account', address: '0xE2c9...5f37', chainId: 130, rows: [['EURC', '2500000'], ['ETH', '120']] },
]
const MONTHS: [month: string, trades: number, volumeEur: string][] = [['2026-11, to date', 14, '17920000'], ['2026-10', 51, '63400000'], ['2026-09', 44, '52800000'], ['2026-08', 38, '41250000']]

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
  }
}

// ---- CSV: the example tables behind "Export CSV". The router adds the column source = demo to each row. ----
type Table = [head: string[], rows: unknown[][]]
export function tables(): Record<string, Table> {
  const i = institution()
  return {
    balances: [['Wallet', 'Address', 'Chain', 'Asset', 'Balance', 'Value (EUR)'], i.balances.flatMap((w) => w.rows.map((r) => [w.wallet, w.address, w.chain, r.asset, r.balance, r.valueEur]))],
    statement: [['Month', 'Trades', 'Volume (EUR)', 'Fee (bps)', 'Fee (EUR)'], i.months.map((m) => [m.month, m.trades, m.volumeEur, m.feeBps, m.feeEur])],
  }
}
