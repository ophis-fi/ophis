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
  try {
    const url = `${base}/api/v2/safes/${args.safe}/balances/`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      log.warn({ status: res.status }, 'safe balances fetch failed');
      return [];
    }
    // v2 returns a paginated envelope { count, next, previous, results: [...] };
    // older deployments return a bare array. Accept both. First page only — for
    // a "does the Safe hold ANY non-WETH value" probe, page 1 is sufficient.
    const json = (await res.json()) as SafeBalanceRow[] | { results?: SafeBalanceRow[] };
    const rows: SafeBalanceRow[] = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : [];
    return rows
      .filter(
        (r) =>
          r.tokenAddress != null && // skip the native coin
          r.tokenAddress.toLowerCase() !== wethLc && // skip WETH (already covered by the pool read)
          r.balance != null &&
          BigInt(r.balance) > 0n,
      )
      .map((r) => ({
        tokenAddress: r.tokenAddress as string,
        symbol: r.token?.symbol ?? 'UNKNOWN',
        balance: r.balance,
      }));
  } catch (err) {
    log.warn({ err }, 'safe balances probe threw');
    return [];
  }
}
