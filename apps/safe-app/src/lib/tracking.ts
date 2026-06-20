// Register the Safe in the rebate indexer's tracked_wallets so the owner-scoped fetcher
// pulls its trades. CoW's /trades API is owner-scoped and cannot be globally enumerated, so
// an appData-tagged order from an UNTRACKED Safe is correctly attributable but NEVER INDEXED,
// meaning the rebate is silently missed. The MCP server does this automatically; a standalone
// Safe App must do it itself. See apps/rebate-indexer src/api.ts (/tier/:wallet -> INSERT INTO
// tracked_wallets) and apps/mcp-server src/tools.ts (submit_order pings GET /tier/<owner>).
//
// Best-effort: a failure (including CORS) MUST NOT block the swap. Before relying on this,
// ensure the indexer allows cross-origin GET from safe.ophis.fi, or move the call server-side.
const REBATE_API = import.meta.env.VITE_OPHIS_REBATE_API ?? 'https://rebates.ophis.fi';

export async function registerTrackedWallet(safeAddress: string): Promise<void> {
  try {
    await fetch(`${REBATE_API}/tier/${safeAddress}`, { method: 'GET', mode: 'cors' });
  } catch (e) {
    console.warn(
      '[ophis] tracked-wallet registration failed; the rebate may not index until this Safe is tracked:',
      (e as Error).message,
    );
  }
}
