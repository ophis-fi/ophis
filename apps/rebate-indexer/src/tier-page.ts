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
 * Optimism volume + tier, and the payout line reflects the ACTUAL batcher
 * state, so the page never implies a payout that has not happened.
 */

type TierName = WalletStatus['tier']['name'];

const TIER_META: Record<TierName, { label: string; color: string }> = {
  bronze: { label: 'Bronze', color: '#c98a5a' },
  silver: { label: 'Silver', color: '#b9c2cf' },
  gold: { label: 'Gold', color: '#e3b341' },
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
  opts: { nextCycleIso: string; lastBatcherRunAt: string | null; flatFeeBps?: number },
): string {
  const meta = TIER_META[status.tier.name];
  const volume = fmtUsd(status.volume_30d_usd);
  // The fee disclaimer MUST match the live fee model. Default = price-improvement
  // ("never touch your principal"). When the flat volume fee is active (the
  // rebate-indexer env REBATE_FLAT_FEE_BPS, kept in lockstep with the frontend
  // REACT_APP_OPHIS_VOLUME_FEE_BPS), a flat fee is charged on trade volume i.e.
  // principal, so the "never touch your principal" claim becomes false -- swap it. (Review P2)
  const feeNote = opts.flatFeeBps
    ? `A flat ${(opts.flatFeeBps / 100).toFixed(2)}% (${opts.flatFeeBps} bps) fee applies to your trade volume; rebates return a share of it by tier.`
    : `Rebates apply to positive price improvement only and never touch your principal.`;
  const share = fmtPct(status.tier.rebate_pct);
  const next = status.next_tier;
  const wallet = shortWallet(status.wallet);
  const nextCycle = fmtCycle(opts.nextCycleIso);

  // Progress bar toward the next tier (capped 0..100). Platinum has no next.
  let progressHtml = '';
  if (next) {
    const span = next.min_usd - status.tier.min_usd;
    const into = status.volume_30d_usd - status.tier.min_usd;
    const pct = span > 0 ? Math.max(0, Math.min(100, Math.round((into / span) * 100))) : 0;
    progressHtml = `
      <div class="progress" role="group" aria-label="Progress to ${TIER_META[next.name].label}">
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <p class="progress-label">${fmtUsd(status.usd_to_next_tier)} more in 30-day volume to reach
          <strong style="color:${TIER_META[next.name].color}">${TIER_META[next.name].label}</strong>
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
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; padding: 32px 20px;
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #e7e7ef;
    background: radial-gradient(1200px 600px at 50% -10%, #1a1b3d 0%, #0e0f1a 55%, #090a12 100%);
  }
  .card {
    width: 100%; max-width: 440px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 18px; padding: 28px;
    box-shadow: 0 24px 60px -30px rgba(0,0,0,0.8);
  }
  .brand { display: flex; align-items: center; gap: 8px; margin-bottom: 22px; }
  .brand .dot { width: 10px; height: 10px; border-radius: 50%; background: #f2a63e; box-shadow: 0 0 12px #f2a63e; }
  .brand b { font-size: 15px; letter-spacing: 0.01em; }
  .brand span { color: #8b8ba3; font-size: 13px; }
  .wallet { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #9a9ab2; margin: 0 0 20px; }
  .tier-badge {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 10px 16px; border-radius: 999px; margin-bottom: 4px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
  }
  .tier-badge .pip { width: 12px; height: 12px; border-radius: 50%; }
  .tier-badge .name { font-size: 20px; font-weight: 700; }
  .tier-badge .share { color: #b9b9cc; font-size: 14px; }
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 22px 0; }
  .stat { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 14px 16px; }
  .stat .k { color: #8b8ba3; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .stat .v { font-size: 22px; font-weight: 600; }
  .progress { margin: 18px 0 4px; }
  .progress-track { height: 8px; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #f2a63e, #ffce7a); border-radius: 999px; }
  .progress-label { color: #b9b9cc; font-size: 13.5px; line-height: 1.5; margin: 10px 0 0; }
  .note { margin: 22px 0; padding: 14px 16px; border-radius: 12px; background: rgba(242,166,62,0.07); border: 1px solid rgba(242,166,62,0.18); color: #d8d2c4; font-size: 13.5px; line-height: 1.55; }
  .actions { display: flex; gap: 10px; margin-top: 8px; }
  .actions a { flex: 1; text-align: center; text-decoration: none; padding: 12px 14px; border-radius: 12px; font-size: 14px; font-weight: 600; }
  .actions .primary { background: #f2a63e; color: #1a1206; }
  .actions .ghost { background: rgba(255,255,255,0.05); color: #e7e7ef; border: 1px solid rgba(255,255,255,0.12); }
  .foot { margin-top: 20px; color: #6f6f86; font-size: 11.5px; line-height: 1.5; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="dot"></span><b>Ophis</b><span>Rebates</span></div>
    <p class="wallet">${wallet}</p>

    <div class="tier-badge">
      <span class="pip" style="background:${meta.color}"></span>
      <span class="name" style="color:${meta.color}">${meta.label}</span>
      <span class="share">${share} rebate share</span>
    </div>

    <div class="stats">
      <div class="stat"><div class="k">30-day volume</div><div class="v">${volume}</div></div>
      <div class="stat"><div class="k">Trades (30d)</div><div class="v">${status.trade_count_30d}</div></div>
    </div>

    ${progressHtml}

    <div class="note">${payoutLine} Figures reflect your real on-chain Ophis trades on Optimism, refreshed daily.</div>

    <div class="actions">
      <a class="primary" href="https://swap.ophis.fi/">Open the app</a>
      <a class="ghost" href="https://docs.ophis.fi/fees">How rebates work</a>
    </div>

    <p class="foot">Tiers are based on rolling 30-day volume. ${feeNote} This page is informational and not a guarantee of any payout amount.</p>
  </main>
</body>
</html>`;
}
