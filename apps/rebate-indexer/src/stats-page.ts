/**
 * Server-rendered HTML for GET /stats when a BROWSER navigates to it
 * (Accept: text/html). API clients (Accept: * / *) get JSON, same as /tier.
 *
 * A PUBLIC, cumulative, lifetime proof surface: total settled volume, trades,
 * traders, and a per-chain breakdown, all drawn from the indexed `trades` table.
 * Deliberately cumulative/lagging only: it never exposes current-cycle 30d volume
 * or the next-payout timing (those stay on the admin-only /status, as they are a
 * front-runner timing signal). Cumulative lifetime totals are not gameable.
 *
 * Self-contained: inline CSS only, no scripts, no external assets, so it works
 * behind the strictest CSP and needs no build step. All interpolated values are
 * numeric or drawn from a fixed chain map, so there is no untrusted markup.
 *
 * Brand: confident, no em-dash, Geist via system fallback (no external font on
 * a strict-CSP page).
 */

export interface PublicStats {
  totalVolumeUsd: number;
  totalTrades: number;
  distinctTraders: number;
  chainsActive: number;
  byChain: { chainId: number; volumeUsd: number; trades: number }[];
  generatedAt: string; // ISO
}

const CHAIN_NAME: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB Chain',
  100: 'Gnosis',
  137: 'Polygon',
  8453: 'Base',
  9745: 'Plasma',
  42161: 'Arbitrum',
  43114: 'Avalanche',
  57073: 'Ink',
  59144: 'Linea',
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtUsd = (n: number): string =>
  '$' + (n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function renderStatsPage(s: PublicStats): string {
  const rows = s.byChain
    .map((c) => {
      const name = CHAIN_NAME[c.chainId] ?? `Chain ${c.chainId}`;
      return `<tr><td>${esc(name)}</td><td class="num">${fmtUsd(c.volumeUsd)}</td><td class="num">${fmtInt(c.trades)}</td></tr>`;
    })
    .join('');
  const updated = esc(s.generatedAt.slice(0, 16).replace('T', ' ')) + ' UTC';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, follow">
<title>Ophis: settled volume and rebate stats</title>
<meta name="description" content="Live, cumulative Ophis stats: settled volume, trades, and traders across 11 EVM chains, indexed on-chain.">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#02000d;color:#f5efe6;font-family:"Geist",ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.5;padding:48px 20px;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.01em;margin-bottom:28px}
.brand .dot{width:11px;height:11px;border-radius:50%;background:#f2a63e;box-shadow:0 0 18px #f2a63e}
h1{font-size:30px;letter-spacing:-.02em;font-weight:600;margin-bottom:8px}
.lede{color:#cfc8bd;font-size:16px;max-width:60ch;margin-bottom:32px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-bottom:32px}
@media(min-width:560px){.grid{grid-template-columns:repeat(4,1fr)}}
.card{background:linear-gradient(180deg,#0b0820,#120d2b);border:1px solid #221b3d;border-radius:16px;padding:18px 20px}
.card .n{font-size:26px;font-weight:600;letter-spacing:-.01em;color:#f5efe6}
.card .l{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9b93b5;margin-top:6px}
.saffron{color:#f2a63e}
h2{font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:#9b93b5;font-weight:500;margin:28px 0 10px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #221b3d}
th{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9b93b5;font-weight:500}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.note{color:#9b93b5;font-size:13px;margin-top:24px;line-height:1.6}
.note a{color:#f2a63e}
.foot{margin-top:28px;padding-top:16px;border-top:1px solid #221b3d;color:#9b93b5;font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
</style></head>
<body><div class="wrap">
<div class="brand"><span class="dot"></span><span>Ophis</span></div>
<h1>Settled, on-chain, and verifiable.</h1>
<p class="lede">Every Ophis trade settles through CoW Protocol's MEV-protected batch auction, with price improvement returned to the trader. These are the cumulative totals, indexed from on-chain settlement.</p>
<div class="grid">
  <div class="card"><div class="n saffron">${fmtUsd(s.totalVolumeUsd)}</div><div class="l">Volume settled</div></div>
  <div class="card"><div class="n">${fmtInt(s.totalTrades)}</div><div class="l">Trades</div></div>
  <div class="card"><div class="n">${fmtInt(s.distinctTraders)}</div><div class="l">Traders</div></div>
  <div class="card"><div class="n">${fmtInt(s.chainsActive)}</div><div class="l">Chains active</div></div>
</div>
<h2>By chain</h2>
<table>
  <thead><tr><th>Chain</th><th class="num">Volume settled</th><th class="num">Trades</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="3" style="color:#9b93b5">No settled volume indexed yet.</td></tr>'}</tbody>
</table>
<p class="note">MEV-protected, gasless, surplus returned to the trader, across 11 EVM chains with Solana and Bitcoin destinations. Figures are cumulative settled volume priced in USD at index time, refreshed continuously. Reproduce them from on-chain settlement: <a href="https://github.com/ophis-fi/ophis">github.com/ophis-fi/ophis</a>.</p>
<div class="foot"><span>swap.ophis.fi</span><span>Updated ${updated}</span></div>
</div></body></html>`;
}
