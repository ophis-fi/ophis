/**
 * Landing page for the bare host root. rebates.ophis.fi is an API host;
 * this page exists so `GET /` neither 404s (GSC flagged that, 2026-06) nor
 * redirects off-host (the interim 301 to the docs was removed 2026-08-20).
 * Static by design: no data dependencies, so the root stays up even when
 * the fetch pipeline or database is degraded.
 */
export function renderRootPage(): string {
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
  .lede { color: #b9b9cc; font-size: 14.5px; line-height: 1.6; margin: 0 0 22px; }
  .actions { display: flex; gap: 10px; margin-top: 8px; }
  .actions a { flex: 1; text-align: center; text-decoration: none; padding: 12px 14px; border-radius: 12px; font-size: 14px; font-weight: 600; }
  .actions .primary { background: #f2a63e; color: #1a1206; }
  .actions .ghost { background: rgba(255,255,255,0.05); color: #e7e7ef; border: 1px solid rgba(255,255,255,0.12); }
  .foot { margin-top: 20px; color: #6f6f86; font-size: 11.5px; line-height: 1.5; }
  .foot code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #9a9ab2; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="dot"></span><b>Ophis</b><span>Rebates</span></div>
    <p class="lede">Fee rebates for Ophis traders. Rebate tiers scale with 30 day trading volume, and payouts are distributed monthly to qualifying wallets.</p>
    <div class="actions">
      <a class="primary" href="https://ophis.fi">Open Ophis</a>
      <a class="ghost" href="https://docs.ophis.fi/fees">Rebate tiers</a>
      <a class="ghost" href="https://docs.ophis.fi/affiliate">Affiliates</a>
    </div>
    <p class="foot">Service endpoints on this host: <code>/stats</code> for program totals and <code>/tier?wallet=0x&hellip;</code> for a wallet's tier.</p>
  </main>
</body>
</html>`;
}
