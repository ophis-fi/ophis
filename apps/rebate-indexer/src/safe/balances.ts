import { logger } from '../logger.js';

const log = logger.child({ module: 'safe-balances' });

// chainId → Safe Transaction Service base. Phase 1 is Gnosis-only (the rebate
// Safe + batcher run on chain 100). Uses the CANONICAL api.safe.global host: the
// legacy safe-transaction-gnosis-chain.safe.global host now 308-redirects here,
// so we target it directly. Env-overridable to match the cow-client convention
// (COW_API_BASE). Unconfigured chains => probe is skipped (returns []).
const TX_SERVICE_BY_CHAIN: Readonly<Record<number, string>> = {
  100: process.env.SAFE_TX_SERVICE_GNOSIS ?? 'https://api.safe.global/tx-service/gno',
};

// Per-request timeout for the balances probe so a stalled Safe API can't hang
// the batcher (the probe runs on the payout path, every cycle).
const FETCH_TIMEOUT_MS = 8_000;

export interface TokenBalance {
  tokenAddress: string;
  symbol: string;
  balance: string; // raw integer string, base units
}

interface SafeBalanceRow {
  tokenAddress: string | null; // null = the native coin
  balance: string;
  token: { symbol?: string } | null;
}

/**
 * Best-effort: list the Safe's ERC20 balances > 0, EXCLUDING WETH and the native
 * coin, via the Safe Transaction Service /balances endpoint (the same service the
 * batcher already uses to propose). Catches ANY token without a hardcoded list,
 * so it can't miss the actual fee token.
 *
 * Used by the batcher's pool===0 path to turn the silent `no_recipients` no-op
 * into a LOUD alert when the Safe is in fact holding fee value in a non-WETH
 * token. Issue #360: CoW partner fees are computed in the trade's surplus token;
 * if a disbursement ever reaches the Safe as a non-WETH token, the WETH-only pool
 * read returns 0 and rebates would silently never pay.
 *
 * NEVER throws — returns [] on any error so it can't break the monthly batch.
 */
export async function getNonWethTokenBalances(args: {
  chainId: number;
  safe: string;
  weth: string;
}): Promise<TokenBalance[]> {
  const base = TX_SERVICE_BY_CHAIN[args.chainId];
  if (!base) return [];
  const wethLc = args.weth.toLowerCase();
  const collected: SafeBalanceRow[] = [];
  try {
    // v2 returns a paginated envelope { count, next, previous, results: [...] };
    // older deployments return a bare array (single page, no `next`). Follow the
    // `next` links so a stranded token on a later page is NOT missed. Page cap is
    // a runaway guard (25 pages ≫ any real Safe's token count); each fetch is
    // timeout-bounded so a stalled API can't hang the (payout-path) batcher.
    let url: string | null = `${base}/api/v2/safes/${args.safe}/balances/`;
    for (let page = 0; url && page < 25; page++) {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        log.warn({ status: res.status, page }, 'safe balances fetch failed');
        break; // page 0 fail → collected empty → []; later page → use what we have
      }
      const json = (await res.json()) as SafeBalanceRow[] | { results?: SafeBalanceRow[]; next?: string | null };
      if (Array.isArray(json)) {
        collected.push(...json);
        break; // bare array is not paginated
      }
      if (Array.isArray(json?.results)) collected.push(...json.results);
      url = json?.next ?? null; // DRF `next` is an absolute URL, or null on the last page
    }
  } catch (err) {
    // Includes AbortSignal timeouts. Fall through and use whatever pages we
    // collected before the error (partial > nothing for a stranding probe).
    log.warn({ err }, 'safe balances probe errored; using partial results');
  }
  // Defensive per-row parse — MUST NOT throw (this runs on the payout path).
  // Skips malformed rows (non-string tokenAddress, unparseable balance, etc.)
  // rather than letting a single bad row bubble an exception into runBatcher.
  const out: TokenBalance[] = [];
  for (const r of collected) {
    try {
      if (typeof r.tokenAddress !== 'string') continue; // null = native coin, or malformed
      if (r.tokenAddress.toLowerCase() === wethLc) continue; // WETH already covered by the pool read
      if (r.balance == null || BigInt(r.balance) <= 0n) continue; // BigInt may throw on a bad string → caught below
      out.push({
        tokenAddress: r.tokenAddress,
        symbol: typeof r.token?.symbol === 'string' ? r.token.symbol : 'UNKNOWN',
        balance: String(r.balance),
      });
    } catch {
      // skip this malformed row
    }
  }
  return out;
}
