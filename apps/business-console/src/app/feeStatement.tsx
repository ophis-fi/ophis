import { useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import { feeTokenAmount, statementCsv, type FeeRow } from './statementCsv.ts'
import { api, Icon, save, Section } from './ui.tsx'

type Page = {
  revision: string
  rows: FeeRow[]
  next: string | null
  coverage: { chain: string; checked: string | null }[]
}
type Range = { from: string; to: string }
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function FeeStatement({
  wallet,
  asOf,
  explorers,
}: {
  wallet: string
  asOf: string
  explorers: Record<number, string>
}) {
  const today = asOf.slice(0, 10)
  const [range, setRange] = useState<Range>({ from: today.slice(0, 8) + '01', to: today })
  const [draft, setDraft] = useState(range)
  const [result, setResult] = useState<(Page & { range: Range }) | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    async function load() {
      setError(false)
      setResult(null)
      const params = new URLSearchParams({ wallet, ...range })
      const rows: FeeRow[] = []
      let revision: string | undefined
      let retries = 0
      while (active) {
        const { status, data } = await api<Page>('/api/partner-statement?' + params)
        if (!active) return
        if (status !== 200) {
          setError(true)
          return
        }
        if (revision !== undefined && revision !== data.revision) {
          if (++retries > 2) {
            setError(true)
            return
          }
          rows.length = 0
          revision = undefined
          params.delete('after')
          continue
        }
        revision = data.revision
        rows.push(...data.rows)
        if (!data.next) {
          rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
          setResult({ ...data, rows, range })
          return
        }
        params.set('after', data.next)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [wallet, range])
  const loaded = result?.range === range ? result : null
  const trades = loaded?.rows.filter((r) => r.kind === 'Trade') ?? []
  const payouts = loaded?.rows.filter((r) => r.kind === 'Payout') ?? []
  function total(rows: FeeRow[], field: 'usd' | 'volume') {
    const priced = rows.filter((r) => r[field] !== null)
    return rows.length && !priced.length
      ? 'Price pending'
      : dollars.format(priced.reduce((sum, r) => sum + Number(r[field]), 0))
  }
  const pending =
    loaded?.coverage.filter((c) => !c.checked || Date.parse(asOf) - Date.parse(c.checked) > 86_400_000) ?? []
  const tokens = new Map<string, { row: FeeRow; atoms: bigint }>()
  for (const r of trades) {
    if (!r.asset || r.atoms === null) continue
    const key = r.chainId + '-' + r.asset
    const group = tokens.get(key)
    if (group) group.atoms += BigInt(r.atoms)
    else tokens.set(key, { row: r, atoms: BigInt(r.atoms) })
  }
  const estimated = trades.filter((r) => r.status === 'Estimated').length
  const unpriced =
    trades.filter((r) => r.volume === null || r.usd === null).length + payouts.filter((r) => r.usd === null).length
  return (
    <Section
      icon="receipt"
      title="Fee statement"
      hint="Choose the settlement dates for trades and the payment dates for receipts. Both dates are included, in UTC."
    >
      <form
        className="acts"
        onSubmit={(e) => {
          e.preventDefault()
          setRange({ ...draft })
        }}
      >
        <label>
          From{' '}
          <input
            type="date"
            required
            max={draft.to}
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </label>
        <label>
          To{' '}
          <input
            type="date"
            required
            min={draft.from}
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </label>
        <button className="btn ghost sm" type="submit">
          Apply dates
        </button>
      </form>
      {loaded ? (
        <>
          <p className="fine">
            {range.from} through {range.to} UTC · {trades.length} settled trades · {payouts.length} payments
          </p>
          <div className="stats">
            <div className="c">
              <span className="num">{total(trades, 'volume')}</span>
              <span className="cap">Trade volume</span>
            </div>
            <div className="c">
              <span className="num">{total(trades, 'usd')}</span>
              <span className="cap">Gross fees charged</span>
              <span className="sub">{estimated} estimated from the order fee rate</span>
            </div>
            <div className="c">
              <span className="num">
                {pending.length && !payouts.length ? 'Awaiting coverage' : total(payouts, 'usd')}
              </span>
              <span className="cap">Payments received</span>
            </div>
          </div>
          {!!unpriced && (
            <p className="fine">
              {unpriced} records await a historical USD price. USD totals include priced amounts only.
            </p>
          )}
          {!!pending.length && (
            <p className="fine">
              Payout history pending for {pending.map((c) => c.chain).join(', ')}. Received totals cover indexed
              transfers.
            </p>
          )}
          <p className="fine">
            CoW payments are transfers from its payouts Safe to this wallet. A payment can cover multiple trades or
            integrations using the same wallet.
          </p>
          {!!tokens.size && (
            <details>
              <summary>Fees charged by token</summary>
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Chain</th>
                      <th>Fee token</th>
                      <th>Amount charged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...tokens.values()].map(({ row, atoms }) => (
                      <tr key={row.id}>
                        <td>{row.chain}</td>
                        <td title={row.asset ?? ''}>{row.symbol ?? row.asset}</td>
                        <td>
                          {row.decimals === null ? atoms.toString() + ' atoms' : formatUnits(atoms, row.decimals)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {!!payouts.length && (
            <details>
              <summary>View payments received</summary>
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Received (UTC)</th>
                      <th>Source</th>
                      <th>Chain</th>
                      <th>Amount</th>
                      <th>Value (USD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...payouts].reverse().map((r) => (
                      <tr key={r.id}>
                        <td>
                          {explorers[r.chainId] && r.tx ? (
                            <a className="link" href={explorers[r.chainId] + r.tx} target="_blank" rel="noopener">
                              {r.at.slice(0, 10)}
                            </a>
                          ) : (
                            r.at.slice(0, 10)
                          )}
                        </td>
                        <td>{r.source}</td>
                        <td>{r.chain}</td>
                        <td>
                          {feeTokenAmount(r)} {r.asset}
                        </td>
                        <td>{r.usd === null ? 'Price pending' : dollars.format(Number(r.usd))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <button
            className="btn ghost sm"
            type="button"
            disabled={draft.from !== range.from || draft.to !== range.to}
            onClick={() =>
              save(
                `ophis-fees-${wallet}-${range.from}-${range.to}.csv`,
                statementCsv(
                  wallet,
                  loaded.rows,
                  pending.map((c) => c.chain),
                ),
              )
            }
          >
            <Icon name="download" size={16} />
            Download statement CSV
          </button>
        </>
      ) : (
        <p role="status" className="muted">
          {error ? 'Statement unavailable. Select Apply dates to retry.' : 'Loading fee statement…'}
        </p>
      )}
    </Section>
  )
}
