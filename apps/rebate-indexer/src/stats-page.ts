/**
 * Server-rendered HTML for GET /stats when a BROWSER navigates to it
 * (Accept: text/html). API clients (Accept: * / *) get JSON, same as /tier.
 *
 * A PUBLIC proof surface, ordered execution-first: (a) the per-trade
 * guarantees of the venue (batch-auction MEV protection, hard signed limit
 * price, gasless settlement, solver competition, improvement split), then
 * (b) the per-chain settled-volume table, then (c) the cumulative lifetime
 * totals with context, then (d) footer links into the fee docs. The lifetime
 * counts stay fully public and unedited; they are simply not the headline.
 *
 * Deliberately cumulative/lagging only: it never exposes current-cycle 30d
 * volume or the next-payout timing (those stay on the admin-only /status, as
 * they are a front-runner timing signal). Cumulative lifetime totals plus
 * static configuration facts are not gameable.
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

export const CHAIN_NAME: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB Chain',
  100: 'Gnosis',
  130: 'Unichain',
  137: 'Polygon',
  8453: 'Base',
  9745: 'Plasma',
  42161: 'Arbitrum',
  43114: 'Avalanche',
  57073: 'Ink',
  59144: 'Linea',
};

/**
 * The production mainnet chains this public surface may report. Derived from the
 * CHAIN_NAME keys so the /stats SQL filter and the display-name map can never
 * drift: every chain that can appear here has a name, and only named chains
 * appear. Used to exclude testnet settlement dust (e.g. Sepolia 11155111) from
 * the cumulative public proof figures.
 */
export const PRODUCTION_CHAIN_IDS: readonly number[] = Object.freeze(
  Object.keys(CHAIN_NAME).map(Number),
);

/**
 * Static execution-model facts served alongside the cumulative figures on the
 * public /stats JSON surface. Configuration facts only, no indexed data and no
 * timing signal, so they are safe to expose (see the current-cycle exclusion in
 * the header comment). `solvers` is the number of engines that can actually BID
 * per auction on each chain; update it when a solver is added or removed in the
 * sovereign driver configs:
 *   - infra/optimism-mainnet/configs/driver.toml.tmpl  (4: baseline, okx,
 *     kyberswap, velora; baseline routes Sushi V2 there)
 *   - infra/unichain-mainnet/configs/driver.toml.tmpl  (9 engine blocks, but the
 *     baseline ships without on-chain AMM sources on Unichain and cannot bid, so
 *     8 aggregators compete: okx, kyberswap, velora, odos, openocean, dodo,
 *     lifi, enso)
 */
export const EXECUTION_FACTS = {
  mevProtection: 'batch-auction',
  settlementModel: 'intent, uniform clearing price',
  solverCompetition: {
    // solvers = engines that can bid (Unichain's baseline ships empty there).
    sovereignChains: [
      { chainId: 10, solvers: 4 },
      { chainId: 130, solvers: 8 },
    ],
    hostedChains: 'CoW Protocol solver network',
  },
  improvementSplit: {
    sovereign: '100% of price improvement returned to the trader',
    hosted: 'CoW Protocol retains 50% of quote improvement upstream',
  },
} as const;

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
<title>Ophis: execution guarantees and settled volume</title>
<meta name="description" content="What every Ophis trade gets: MEV-protected batch settlement, a hard signed limit price, gasless execution, and solver competition. Plus cumulative settled volume, indexed on-chain.">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#02000d;color:#f5efe6;font-family:"Geist",ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.5;padding:48px 20px;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.01em;margin-bottom:28px}
.brand .dot{width:11px;height:11px;border-radius:50%;background:#f2a63e;box-shadow:0 0 18px #f2a63e}
h1{font-size:30px;letter-spacing:-.02em;font-weight:600;margin-bottom:8px}
.lede{color:#cfc8bd;font-size:16px;max-width:60ch;margin-bottom:32px}
.gl{list-style:none;display:grid;gap:14px;margin-bottom:32px}
@media(min-width:560px){.gl{grid-template-columns:repeat(2,1fr)}.gl li.wide{grid-column:1/-1}}
.gl li{background:linear-gradient(180deg,#0b0820,#120d2b);border:1px solid #221b3d;border-radius:16px;padding:16px 18px;font-size:14px;color:#cfc8bd}
.gl li strong{display:block;color:#f5efe6;font-weight:600;margin-bottom:4px}
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
.foot a{color:#f2a63e;text-decoration:none}
</style></head>
<body><div class="wrap">
<div class="brand"><span class="dot"></span><span>Ophis</span></div>
<h1>Every trade settles MEV-protected, at your signed price or better.</h1>
<p class="lede">Ophis is an intent-based venue on CoW Protocol's batch auction with a uniform clearing price. The guarantees below hold for every single trade, regardless of size or volume.</p>
<ul class="gl">
  <li><strong>MEV-protected batch settlement</strong>Orders settle in batch auctions, not the public mempool. No sandwiching, no frontrunning of your order flow.</li>
  <li><strong>Hard signed limit price</strong>Your signed order is a contract-enforced price floor. A fill below it cannot settle on-chain.</li>
  <li><strong>Gasless execution</strong>Solvers pay the settlement gas and costs settle inside the trade. After a one-time token approval before the first sell, no native gas token is needed, and failed settlements cost you nothing.</li>
  <li><strong>Solver competition on every order</strong>On Unichain, 8 aggregator solvers compete per auction (plus a baseline that ships without on-chain AMM sources there); on Optimism, 4 solvers compete, where Ophis runs the full settlement stack. Other chains draw on CoW Protocol's solver network.</li>
  <li class="wide"><strong>Where the price improvement goes</strong>On Optimism and Unichain, 100% of price improvement is returned to the trader, and the Ophis fee is all-in (0.10% on the swap app, 0.05% for SDK and MCP partners; 0.01% on same-chain stable pairs). On CoW-hosted chains, CoW Protocol adds a 0.02% volume fee (0.003% on correlated pairs) and retains 50% of quote improvement upstream, capped at 0.98% of volume.</li>
</ul>
<h2>Settled volume by chain</h2>
<table>
  <thead><tr><th>Chain</th><th class="num">Volume settled</th><th class="num">Trades</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="3" style="color:#9b93b5">No settled volume indexed yet.</td></tr>'}</tbody>
</table>
<h2>Lifetime settled volume, cumulative</h2>
<p class="note" style="margin-top:0;margin-bottom:14px">Ophis is an early-stage venue, so these are lifetime totals since launch, not a rolling window. Every figure is indexed from on-chain settlement and verifiable by anyone.</p>
<div class="grid">
  <div class="card"><div class="n saffron">${fmtUsd(s.totalVolumeUsd)}</div><div class="l">Volume settled</div></div>
  <div class="card"><div class="n">${fmtInt(s.totalTrades)}</div><div class="l">Trades</div></div>
  <div class="card"><div class="n">${fmtInt(s.distinctTraders)}</div><div class="l">Traders</div></div>
  <div class="card"><div class="n">${fmtInt(s.chainsActive)}</div><div class="l">Chains active</div></div>
</div>
<p class="note">MEV-protected, gasless, surplus returned to the trader, across 12 EVM chains with Solana and Bitcoin destinations. Figures are cumulative settled volume priced in USD at index time, refreshed continuously. Reproduce them from on-chain settlement: <a href="https://github.com/ophis-fi/ophis">github.com/ophis-fi/ophis</a>.</p>
<div class="foot"><span><a href="https://docs.ophis.fi/fees">Fee model</a> &middot; <a href="https://docs.ophis.fi/comparison">How Ophis compares</a> &middot; swap.ophis.fi</span><span>Updated ${updated}</span></div>
</div></body></html>`;
}
