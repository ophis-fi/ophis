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
 * Brand: Steep editorial palette, Georgia headings and system sans fallback.
 * No external font requests on this strict-CSP page.
 */

export interface PublicStats {
  totalVolumeUsd: number;
  totalTrades: number;
  distinctTraders: number;
  chainsActive: number;
  byChain: { chainId: number; volumeUsd: number; trades: number }[];
  generatedAt: string; // ISO
  /** Last completed scorer publication. Unlike generatedAt, this cannot be
   * refreshed merely by serving another HTTP response. */
  dataAsOf: string | null;
  dataFresh: boolean;
  dataStatus: 'fresh' | 'degraded';
  dataStaleReason: string | null;
}

export const CHAIN_NAME: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB Chain',
  100: 'Gnosis',
  130: 'Unichain',
  137: 'Polygon',
  4663: 'Robinhood Chain',
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
 * the header comment). `solvers` is the number of configured lanes capable of
 * returning bids for supported pairs; actual per-auction participation depends
 * on pair support and runtime availability. Update it with the driver configs.
 */
export const EXECUTION_FACTS = {
  mevProtection: 'batch-auction',
  settlementModel: 'intent, uniform clearing price',
  solverCompetition: {
    // Baseline has modeled liquidity on Optimism; it is excluded on Unichain
    // and Robinhood, where the baseline liquidity reader is intentionally empty.
    sovereignChains: [
      { chainId: 10, solvers: 11 },
      { chainId: 130, solvers: 7 },
      { chainId: 4663, solvers: 6 },
    ],
    hostedChains: 'CoW Protocol solver network',
  },
  improvementSplit: {
    sovereign: 'Ophis retains 80% of volatile improvement (99 bps cap) or 50% of stable improvement (20 bps cap)',
    hosted: 'The same Ophis capped capture applies, plus CoW Protocol quote-improvement fees upstream',
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
  const updated = s.dataAsOf
    ? esc(s.dataAsOf.slice(0, 16).replace('T', ' ')) + ' UTC'
    : null;
  const freshnessWarning = s.dataFresh
    ? ''
    : `<div class="warning"><strong>Data refresh delayed.</strong> These figures show the last successful publication${updated ? ` at ${updated}` : ''}. On-chain settlements remain final while indexing catches up.</div>`;
  const operatedSolverSummary = EXECUTION_FACTS.solverCompetition.sovereignChains
    .map(({ chainId, solvers }) => `${CHAIN_NAME[chainId] ?? `Chain ${chainId}`}: ${solvers}`)
    .join(', ');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, follow">
<title>Ophis: execution guarantees and settled volume</title>
<meta name="description" content="What every Ophis trade gets: MEV-protected batch settlement, a hard signed limit price, gasless execution, and solver competition. Plus cumulative settled volume, indexed on-chain.">
<meta name="theme-color" content="#ffffff">
<style>
:root{color-scheme:light}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#ffffff;color:#17191c;font-family:Inter,system-ui,-apple-system,sans-serif;line-height:1.5;padding:32px 16px;font-variant-numeric:lining-nums tabular-nums;-webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:48px}
.brand a{color:#17191c;font-size:24px;text-decoration:none}
.brand span{font-size:14px;color:#5b606b}
h1{font:400 clamp(36px,6vw,64px)/1.15 Georgia,serif;letter-spacing:-.015em;margin-bottom:20px;max-width:22ch}
.lede{color:#5b606b;font-size:17px;max-width:65ch;margin-bottom:32px}
.gl{list-style:none;display:grid;gap:16px;margin-bottom:48px}
@media(min-width:560px){.gl{grid-template-columns:repeat(2,minmax(0,1fr))}.gl li.wide{grid-column:1/-1}}
.gl li{background:#f2f2f3;border-radius:24px;padding:24px;font-size:15px;color:#5b606b}
.gl li strong{display:block;color:#17191c;font-weight:500;margin-bottom:8px}
.gl li.wide,.gl li.wide strong{background:#fbe1d1;color:#5d2a1a}
.grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin-bottom:32px}
@media(min-width:440px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(min-width:960px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.card{background:#f2f2f3;border-radius:16px;padding:20px;min-width:0}
.card .n{font-size:clamp(22px,4vw,30px);font-weight:500;letter-spacing:-.01em;overflow-wrap:anywhere}
.card .l{font-size:13px;color:#5b606b;margin-top:8px}
h2{font:400 28px/1.25 Georgia,serif;letter-spacing:-.015em;margin:40px 0 20px}
.table-scroll{overflow-x:auto;border:1px solid #d9d9dc;border-radius:16px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:12px 16px;border-bottom:1px solid #e8e8ea}
th{background:#fafafb;color:#5b606b;font-weight:500}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;white-space:nowrap}
.note{color:#5b606b;font-size:14px;margin-top:24px;line-height:1.6;overflow-wrap:anywhere}
a{color:inherit;text-underline-offset:3px}
a:hover{text-decoration:underline}
a:focus-visible,.table-scroll:focus-visible{outline:2px solid #17191c;outline-offset:4px}
.warning{background:#faeed3;border:1px solid #b99a56;border-radius:16px;color:#7c4a03;font-size:14px;margin-bottom:24px;padding:16px 20px}
.foot{margin-top:32px;padding-top:20px;border-top:1px solid #d9d9dc;color:#5b606b;font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px}
.foot a{display:inline-block;padding:10px 0}
</style></head>
<body><main class="wrap">
<nav class="brand" aria-label="Ophis"><a href="https://ophis.fi/">Ophis</a><span>Execution &amp; volume</span></nav>
${freshnessWarning}
<h1>Every trade settles MEV-protected, at your signed price or better.</h1>
<p class="lede">Ophis is an intent-based venue on CoW Protocol's batch auction with a uniform clearing price. The guarantees below hold for every single trade, regardless of size or volume.</p>
<ul class="gl">
  <li><strong>MEV-protected batch settlement</strong>Orders settle in batch auctions, not the public mempool. No sandwiching, no frontrunning of your order flow.</li>
  <li><strong>Hard signed limit price</strong>Your signed order is a contract-enforced price floor. A fill below it cannot settle on-chain.</li>
  <li><strong>Gasless execution</strong>Solvers pay the settlement gas and costs settle inside the trade. After a one-time token approval before the first sell, no native gas token is needed, and failed settlements cost you nothing.</li>
  <li><strong>Solver competition on every order</strong>Configured Ophis-operated routing lanes: ${esc(operatedSolverSummary)}. Pair coverage and live participation vary by auction. Other chains draw on ${esc(EXECUTION_FACTS.solverCompetition.hostedChains)}.</li>
  <li class="wide"><strong>Where the price improvement goes</strong>The Ophis fee on every supported chain is a 0.01% (1 bp) base plus 80% of reference-quote improvement on volatile pairs (99 bps cap), or 50% on stable pairs (20 bps cap). CoW-hosted chains also apply CoW Protocol fees upstream.</li>
</ul>
<h2>Settled volume by chain</h2>
<div class="table-scroll" role="region" aria-label="Settled volume by chain" tabindex="0">
<table>
  <thead><tr><th>Chain</th><th class="num">Volume settled</th><th class="num">Trades</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="3" style="color:#5b606b">No settled volume indexed yet.</td></tr>'}</tbody>
</table>
</div>
<h2>Lifetime settled volume, cumulative</h2>
<p class="note" style="margin-top:0;margin-bottom:14px">Ophis is an early-stage venue, so these are lifetime totals since launch, not a rolling window. Every figure is indexed from on-chain settlement and verifiable by anyone.</p>
<div class="grid">
  <div class="card"><div class="n">${fmtUsd(s.totalVolumeUsd)}</div><div class="l">Volume settled</div></div>
  <div class="card"><div class="n">${fmtInt(s.totalTrades)}</div><div class="l">Trades</div></div>
  <div class="card"><div class="n">${fmtInt(s.distinctTraders)}</div><div class="l">Traders</div></div>
  <div class="card"><div class="n">${fmtInt(s.chainsActive)}</div><div class="l">Chains active</div></div>
</div>
<p class="note">MEV-protected and gasless across 13 EVM chains with Solana and Bitcoin destinations. On Ophis-operated chains, the trader keeps the remainder after Ophis's capped capture and all improvement above its cap. On hosted chains, the trader receives the net remainder after both Ophis's policy and CoW Protocol's separate upstream policy. Figures are cumulative settled volume priced in USD at index time, refreshed continuously. Reproduce them from on-chain settlement: <a href="https://github.com/ophis-fi/ophis">github.com/ophis-fi/ophis</a>.</p>
<div class="foot"><span><a href="https://docs.ophis.fi/fees">Fee model</a> &middot; <a href="https://docs.ophis.fi/comparison">How Ophis compares</a> &middot; <a href="https://swap.ophis.fi/">Open the app</a></span><span>${updated ? `Data as of ${updated}` : 'Data publication time unavailable'}</span></div>
</main></body></html>`;
}
