import type { WalletStatus } from './tierer.js';

/**
 * Server-rendered HTML for GET /tier/:wallet when a BROWSER navigates to it
 * (Accept: text/html), e.g. clicking the rebate chip on the swap page. API
 * clients (the chip's own fetch, which sends Accept: * / *) still get JSON.
 *
 * Self-contained: inline CSS only, no scripts, no external assets, so it works
 * behind the strictest CSP and needs no build step. All interpolated values are
 * either validated upstream (wallet matches ^0x[0-9a-f]{40}$ in the route),
 * numeric, or drawn from the fixed TIERS enum, so there is no untrusted markup.
 *
 * Honesty (review item #17): the figures are this wallet's REAL indexed
 * cross-chain volume + tier (the wallets matview sums value_usd across every
 * indexed chain, not just one), and the payout line reflects the ACTUAL batcher
 * state, so the page never implies a payout that has not happened.
 */

type TierName = WalletStatus['tier']['name'];

const TIER_META: Record<TierName, { label: string; color: string }> = {
  none: { label: 'Unranked', color: '#8b8ba3' },
  bronze: { label: 'Bronze', color: '#c98a5a' },
  silver: { label: 'Silver', color: '#b9c2cf' },
  gold: { label: 'Gold', color: '#e3b341' },
  palladium: { label: 'Palladium', color: '#cdd6e0' },
  platinum: { label: 'Platinum', color: '#9fd8e6' },
};

function fmtUsd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtPct(fraction: number): string {
  return Math.round(fraction * 100) + '%';
}

function shortWallet(w: string): string {
  // ASCII-only ellipsis to keep served content free of non-ASCII punctuation.
  return w.slice(0, 6) + '...' + w.slice(-4);
}

function fmtCycle(iso: string): string {
  // "1 July 2026" style, UTC, no locale surprises on the server.
  const d = new Date(iso);
  const month = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

export function renderTierPage(
  status: WalletStatus,
  opts: { nextCycleIso: string; lastBatcherRunAt: string | null },
): string {
  const meta = TIER_META[status.tier.name];
  const volume = fmtUsd(status.volume_30d_usd);
  const share = fmtPct(status.tier.rebate_pct);
  const next = status.next_tier;
  const wallet = shortWallet(status.wallet);
  const nextCycle = fmtCycle(opts.nextCycleIso);

  // Canonical all-chain fee disclaimer. Keep this synchronized with the public
  // pricing page and machine-readable documentation.
  const feeNote =
    'Every supported chain charges a 0.01% (1 bp) Ophis base plus capped reference-quote-improvement capture: 80% capped at 99 bps on volatile pairs, or 50% capped at 20 bps on stable pairs. Verified fee-bearing trades determine eligibility and volume weighting; the rebate pool is funded from the Ophis Safe\'s distributable non-partner WETH balance, which can include collected improvement fees.';

  // Progress bar toward the next tier (capped 0..100). Platinum has no next.
  let progressHtml = '';
  if (next) {
    const span = next.min_usd - status.tier.min_usd;
    const into = status.volume_30d_usd - status.tier.min_usd;
    const pct = span > 0 ? Math.max(0, Math.min(100, Math.round((into / span) * 100))) : 0;
    progressHtml = `
      <div class="progress" role="group" aria-label="Progress to ${TIER_META[next.name].label}">
        <div class="progress-track" role="progressbar" aria-label="Tier progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${pct}%"></div></div>
        <p class="progress-label">${fmtUsd(status.usd_to_next_tier)} more in 30-day volume to reach
          <strong>${TIER_META[next.name].label}</strong>
          (${fmtPct(next.rebate_pct)} rebate share)</p>
      </div>`;
  } else {
    progressHtml = `<p class="progress-label">You are at the top tier. Your rebate share is the maximum.</p>`;
  }

  // Payout line reflects the real batcher state, so it never overstates.
  const payoutLine = opts.lastBatcherRunAt
    ? `Rebate payouts are distributed monthly to qualifying wallets. The next distribution cycle is <strong>${nextCycle}</strong>.`
    : `Rebate payouts are distributed monthly to qualifying wallets. The first distribution cycle is scheduled for <strong>${nextCycle}</strong>; none have run yet.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Ophis Rebates</title>
<meta name="theme-color" content="#ffffff">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; padding: 32px 16px;
    font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-variant-numeric: lining-nums tabular-nums;
    color: #17191c; background: #ffffff; line-height: 1.5;
  }
  .card { width: 100%; max-width: 560px; margin: 0 auto; padding: clamp(16px, 4vw, 32px); }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 32px; }
  .brand a { color: #17191c; font-size: 24px; text-decoration: none; }
  .brand span, .wallet, .tier-badge .share, .stat .k, .progress-label, .foot { color: #5b606b; }
  .wallet { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; margin: 0 0 16px; }
  h1 { margin: 0 0 24px; font: 400 clamp(36px, 8vw, 52px)/1.15 Georgia, serif; letter-spacing: -0.015em; }
  .tier-badge { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .tier-badge .pip { width: 12px; height: 12px; border-radius: 50%; border: 1px solid #5b606b; }
  .tier-badge .name { font-size: 20px; font-weight: 500; }
  .tier-badge .share { font-size: 14px; }
  .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 24px 0; }
  .stat { background: #f2f2f3; border-radius: 16px; padding: 16px; min-width: 0; }
  .stat .k { font-size: 12px; margin-bottom: 8px; }
  .stat .v { font-size: clamp(20px, 5vw, 28px); font-weight: 500; overflow-wrap: anywhere; }
  .progress { margin: 24px 0 0; }
  .progress-track { height: 8px; border-radius: 4px; background: #d9d9dc; overflow: hidden; }
  .progress-fill { height: 100%; background: #17191c; border-radius: 4px; }
  .progress-label { font-size: 14px; margin: 12px 0 0; }
  .note { margin: 24px 0; padding: 20px; border-radius: 16px; background: #fbe1d1; color: #5d2a1a; font-size: 14px; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; }
  .actions a { flex: 1 1 180px; min-height: 44px; text-align: center; text-decoration: none; padding: 12px 16px; border: 1px solid #17191c; border-radius: 12px; font-size: 14px; }
  .actions .primary { background: #17191c; color: #ffffff; }
  .actions .primary:hover { background: #353941; }
  .actions .ghost { background: #ffffff; color: #17191c; }
  .actions .ghost:hover { background: #f2f2f3; }
  a:focus-visible { outline: 2px solid #17191c; outline-offset: 4px; }
  .foot { margin-top: 24px; font-size: 13px; }
</style>
</head>
<body>
  <main class="card">
    <nav class="brand" aria-label="Ophis"><a href="https://ophis.fi/">Ophis</a><span>Rebates</span></nav>
    <h1>Your trading rewards.</h1>
    <p class="wallet">${wallet}</p>

    <div class="tier-badge">
      <span class="pip" style="background:${meta.color}"></span>
      <span class="name">${meta.label}</span>
      <span class="share">${share} rebate share</span>
    </div>

    <div class="stats">
      <div class="stat"><div class="k">30-day volume</div><div class="v">${volume}</div></div>
      <div class="stat"><div class="k">Trades (30d)</div><div class="v">${status.trade_count_30d}</div></div>
    </div>

    ${progressHtml}

    <div class="note">${payoutLine} Figures reflect your real on-chain Ophis trades across all supported chains, refreshed daily.</div>

    <div class="actions">
      <a class="primary" href="https://swap.ophis.fi/">Open the app</a>
      <a class="ghost" href="https://docs.ophis.fi/fees">How rebates work</a>
    </div>

    <p class="foot">Tiers are based on rolling 30-day volume. ${feeNote} This page is informational and not a guarantee of any payout amount.</p>
  </main>
</body>
</html>`;
}
