import { formatUnits } from 'viem'
import { csvCell } from '../csv.ts'

export type FeeRow = {
  id: string
  kind: 'Trade' | 'Payout'
  status: 'Estimated' | 'Assessed' | 'Received'
  source: 'Ophis' | 'CoW'
  chainId: number
  chain: string
  at: string
  tx: string | null
  uid: string | null
  block: string | null
  log: number | null
  volume: string | null
  bps: number | null
  asset: string | null
  symbol: string | null
  atoms: string | null
  decimals: number | null
  usd: string | null
}
export const feeTokenAmount = (r: FeeRow) => (r.atoms !== null && r.decimals !== null ? formatUnits(BigInt(r.atoms), r.decimals) : '')

export function statementCsv(wallet: string, rows: FeeRow[], pendingChains: string[]) {
  const head = [
    'Partner wallet',
    'Record type',
    'Source',
    'UTC time',
    'Chain ID',
    'Chain',
    'Transaction hash',
    'Order UID',
    'Block',
    'Log index',
    'Volume (USD)',
    'Fee rate (bps)',
    'Fee status',
    'Asset or token address',
    'Symbol',
    'Amount (token units)',
    'Amount (atoms)',
    'Token decimals',
    'Fee charged (USD)',
    'Payment received (USD)',
    'Payout history pending (chains)',
  ]
  const coverage = Array<string>(head.length).fill('')
  coverage[0] = wallet
  coverage[1] = 'Coverage'
  coverage[coverage.length - 1] = pendingChains.join(', ')
  return [
    head,
    ...(!rows.length && pendingChains.length ? [coverage] : []),
    ...rows.map((r) => [
      wallet,
      r.kind,
      r.source,
      r.at,
      r.chainId,
      r.chain,
      r.tx,
      r.uid,
      r.block,
      r.log,
      r.volume,
      r.bps,
      r.status,
      r.asset,
      r.symbol,
      feeTokenAmount(r),
      r.atoms,
      r.decimals,
      r.kind === 'Trade' ? r.usd : null,
      r.kind === 'Payout' ? r.usd : null,
      pendingChains.join(', '),
    ]),
  ]
    .map((row) => row.map(csvCell).join(',') + '\r\n')
    .join('')
}
