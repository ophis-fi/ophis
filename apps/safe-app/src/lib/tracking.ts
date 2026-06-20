// Register the Safe in the rebate indexer's tracked_wallets so the owner-scoped fetcher
// pulls its trades. CoW's /trades API is owner-scoped and cannot be globally enumerated, so
// an appData-tagged order from an UNTRACKED Safe is correctly attributable but NEVER INDEXED,
// meaning the rebate is silently missed. The MCP server does this automatically; a standalone
// Safe App must do it itself.
//
// Thin wrapper over @ophis/sdk's enrollOphisTrader, which validates the address, enforces an
// https host (no plaintext / embedded-credential leak of the wallet in the request path), and
// THROWS on a network error or non-2xx. We intentionally DO NOT swallow here: the submit flow
// awaits this before sendOrder and surfaces a visible, non-blocking warning on failure.
import { enrollOphisTrader } from '@ophis/sdk';

// host: use VITE_OPHIS_REBATE_API when set, otherwise let enrollOphisTrader default
// (https://rebates.ophis.fi). Passing `undefined` host falls through to that default.
const REBATE_API: string | undefined = import.meta.env.VITE_OPHIS_REBATE_API || undefined;

export async function enrollTrackedWallet(safeAddress: string): Promise<void> {
  await enrollOphisTrader(safeAddress, REBATE_API ? { host: REBATE_API } : undefined);
}
