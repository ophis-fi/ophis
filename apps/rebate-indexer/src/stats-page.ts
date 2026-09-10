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
 * Native GET filters and sorting need no scripts or build step. Chain icons
 * come from the local copies of the fixed Ophis brand asset map. Query inputs are normalized before
 * use; interpolated strings are escaped for HTML attributes and text.
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
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtUsd = (n: number): string =>
  '$' + (n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

export const CHAIN_ICON: Record<number, string> = {
  1: 'chain-ethereum.png', 10: 'chain-optimism.png', 56: 'chain-bnb.png',
  100: 'chain-gnosis.png', 130: 'chain-unichain.svg', 137: 'chain-polygon.png',
  4663: 'chain-robinhood-v2.svg', 8453: 'chain-base.png', 9745: 'chain-plasma.svg',
  42161: 'chain-arbitrum.jpg', 43114: 'chain-avalanche.png', 57073: 'chain-ink.svg', 59144: 'chain-linea.jpg',
};

export function renderStatsPage(s: PublicStats, query = new URLSearchParams()): string {
  const sort = query.get('sort') ?? 'volume-desc';
  const activeSort = /^(chain|volume|trades)-(asc|desc)$/.test(sort) ? sort : 'volume-desc';
  const [column, direction] = activeSort.split('-');
  const chainId = Number(query.get('chain'));
  const chain = PRODUCTION_CHAIN_IDS.includes(chainId) ? chainId : 0;
  const range = (key: string): number | undefined => {
    const raw = query.get(key);
    if (!raw?.trim()) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const minVolume = range('minVolume'), maxVolume = range('maxVolume');
  const minTrades = range('minTrades'), maxTrades = range('maxTrades');
  const filtered = s.byChain.filter(c => (!chain || c.chainId === chain)
    && (minVolume === undefined || c.volumeUsd >= minVolume)
    && (maxVolume === undefined || c.volumeUsd <= maxVolume)
    && (minTrades === undefined || c.trades >= minTrades)
    && (maxTrades === undefined || c.trades <= maxTrades));
  filtered.sort((a, b) => {
    const compared = column === 'chain'
      ? (CHAIN_NAME[a.chainId] ?? String(a.chainId)).localeCompare(CHAIN_NAME[b.chainId] ?? String(b.chainId), 'en')
      : column === 'trades' ? a.trades - b.trades : a.volumeUsd - b.volumeUsd;
    return (direction === 'asc' ? compared : -compared) || a.chainId - b.chainId;
  });
  const rows = filtered.map(c => {
    const name = CHAIN_NAME[c.chainId] ?? `Chain ${c.chainId}`;
    const icon = CHAIN_ICON[c.chainId];
    return `<tr><th scope="row"><span class="chain">${icon ? `<img src="/chain-icons/${c.chainId}" width="24" height="24" alt="" decoding="async">` : ''}${esc(name)}</span></th><td class="num">${fmtUsd(c.volumeUsd)}</td><td class="num">${fmtInt(c.trades)}</td></tr>`;
  }).join('');
  const heading = (key: string, label: string): string => {
    const selected = key === column;
    const next = selected ? direction === 'desc' ? 'asc' : 'desc' : key === 'chain' ? 'asc' : 'desc';
    return `<th scope="col"${key !== 'chain' ? ' class="num"' : ''} aria-sort="${selected ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}"><button name="sort" value="${key}-${next}" aria-label="Sort ${label.toLowerCase()} ${next === 'asc' ? 'ascending' : 'descending'}">${label} <span aria-hidden="true">${selected ? direction === 'asc' ? '&#8593;' : '&#8595;' : '&#8597;'}</span></button></th>`;
  };
  const numberInput = (key: string, label: string, value: number | undefined): string =>
    `<label><span>${label}</span><input type="number" min="0" step="${key.endsWith('Trades') ? '1' : 'any'}" name="${key}" value="${value ?? ''}" placeholder="Any"></label>`;
  const chainOptions = PRODUCTION_CHAIN_IDS.map(id => `<option value="${id}"${chain === id ? ' selected' : ''}>${esc(CHAIN_NAME[id] ?? `Chain ${id}`)}</option>`).join('');
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
thead th{background:#fafafb;color:#5b606b;font-weight:500}
tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}
td.num,th.num{text-align:right;white-space:nowrap}
.note{color:#5b606b;font-size:14px;margin-top:24px;line-height:1.6;overflow-wrap:anywhere}
a{color:inherit;text-underline-offset:3px}
a:hover{text-decoration:underline}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,.table-scroll:focus-visible{outline:2px solid #17191c;outline-offset:4px}
.warning{background:#faeed3;border:1px solid #b99a56;border-radius:16px;color:#7c4a03;font-size:14px;margin-bottom:24px;padding:16px 20px}
.foot{margin-top:32px;padding-top:20px;border-top:1px solid #d9d9dc;color:#5b606b;font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px}
.foot a{display:inline-block;padding:10px 0}
.chain{display:flex;align-items:center;gap:12px;white-space:nowrap}
.chain img{border-radius:50%;flex-shrink:0;object-fit:contain}
tbody th{font-weight:400;background:transparent}
tbody tr:hover{background:#fafafb}
.filters{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin:20px 0 16px}
.filters>label{display:flex;flex-direction:column;justify-content:space-between}
.filters fieldset{border:0;min-width:0}
.filters legend,.filters>label>span{font-size:13px;color:#5b606b;margin-bottom:8px;display:block}
.range{display:flex;gap:8px}.range label{flex:1;min-width:0}
.range span{display:block;font-size:12px;color:#5b606b;margin-bottom:4px}
input,select{width:100%;min-width:0;height:44px;background:white;border:1px solid #d9d9dc;border-radius:8px;padding:8px 10px;font:inherit;font-size:16px;color:inherit}
button{cursor:pointer;font:inherit;color:inherit;border:0;background:transparent;min-height:44px}
thead button{display:inline-flex;align-items:center;gap:8px;text-align:inherit}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:16px;margin-bottom:16px;font-size:14px}
.actions button{padding:8px 16px;border-radius:8px;background:#17191c;color:white}
.actions a{display:inline-flex;align-items:center;min-height:44px}
.actions p{margin-left:auto;color:#5b606b;font-size:13px}
caption{text-align:left;padding:12px 16px;font-size:13px;color:#5b606b;border-bottom:1px solid #e8e8ea}
#chains{scroll-margin-top:24px}
@media(max-width:600px){.filters{grid-template-columns:1fr}.actions p{width:100%;margin:0}.chain{gap:8px}th,td{padding:10px 12px}table{min-width:420px}}
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
<h2 id="chains">Settled volume by chain</h2>
<form method="get" action="/stats#chains" aria-label="Filter settled volume">
<div class="filters">
  <label><span>Chain</span><select name="chain"><option value="">All chains</option>${chainOptions}</select></label>
  <fieldset><legend>Volume settled (USD)</legend><div class="range">${numberInput('minVolume', 'Minimum volume', minVolume)}${numberInput('maxVolume', 'Maximum volume', maxVolume)}</div></fieldset>
  <fieldset><legend>Trades</legend><div class="range">${numberInput('minTrades', 'Minimum trades', minTrades)}${numberInput('maxTrades', 'Maximum trades', maxTrades)}</div></fieldset>
</div>
<div class="actions"><button name="sort" value="${activeSort}">Apply filters</button><a href="/stats#chains">Reset</a><p>Showing ${filtered.length} of ${s.byChain.length} chains. Lifetime totals below include all chains.</p></div>
<div class="table-scroll" role="region" aria-label="Settled volume by chain" tabindex="0">
<table>
  <caption>Lifetime settled volume by chain. Select a column heading to sort.</caption>
  <thead><tr>${heading('chain', 'Chain')}${heading('volume', 'Volume settled')}${heading('trades', 'Trades')}</tr></thead>
  <tbody>${rows || `<tr><td colspan="3">${s.byChain.length ? 'No chains match these filters.' : 'No settled volume indexed yet.'}</td></tr>`}</tbody>
</table>
</div>
</form>
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
