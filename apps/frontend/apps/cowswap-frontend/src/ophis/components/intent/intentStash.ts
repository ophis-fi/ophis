/**
 * Session-scoped stash of a parsed swap intent, so the user's chosen trade
 * (tokens + chain + amount) SURVIVES the wallet-connect handoff.
 *
 * Why this exists: when a not-yet-connected visitor submits an intent, they are
 * routed to /:chainId/swap/:sell/:buy?sellAmount=… with the form pre-filled. On
 * connect, cowswap's useSetupTradeState re-derives trade state from the provider
 * and can navigate to the chain's DEFAULT pair (getDefaultTradeRawState), wiping
 * the tokens the visitor picked. IntentRestoreUpdater reads this stash on the
 * connect transition and re-navigates to the intended trade.
 *
 * Storage: sessionStorage (per-tab, per-origin). Never throws — a blocked or
 * full store (private mode, injected widget) silently degrades to "no restore",
 * never breaking the swap surface. Injected-widget builds never write the stash
 * (the landing page that writes it is not mounted there).
 */
export const INTENT_STASH_KEY = 'ophis:intent:v1'

// Restore only a FRESH handoff. A tab left open longer than this is not a live
// "search then connect" flow, so we let cowswap's default apply instead.
const DEFAULT_TTL_MS = 10 * 60 * 1000

export interface IntentStash {
  /**
   * Parsed chain from the intent, or undefined when the user named no chain
   * (restore then uses the connected wallet's chain — never forces a switch).
   */
  chainId?: number
  /**
   * Resolved token ids (on-chain address when known, else the bare symbol),
   * matching exactly what intentToUrl put in the path.
   */
  sellToken?: string
  buyToken?: string
  /** Human-readable amount (whole units), e.g. "100" — NOT atomic/wei. */
  amount?: string
  /** Which side the amount binds to (mirrors the URL sellAmount/buyAmount key). */
  field: 'sell' | 'buy'
  /** Epoch ms when written; used for the freshness (TTL) check. */
  ts: number
}

export function writeIntentStash(stash: Omit<IntentStash, 'ts'>): void {
  try {
    sessionStorage.setItem(INTENT_STASH_KEY, JSON.stringify({ ...stash, ts: Date.now() }))
  } catch {
    // sessionStorage unavailable/blocked/full — degrade to no-restore.
  }
}

export function readIntentStash(ttlMs: number = DEFAULT_TTL_MS): IntentStash | null {
  try {
    const raw = sessionStorage.getItem(INTENT_STASH_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<IntentStash> | null
    if (!parsed || typeof parsed.ts !== 'number') return null
    if (Date.now() - parsed.ts > ttlMs) return null
    // Need at least one token to build a meaningful trade route.
    if (!parsed.sellToken && !parsed.buyToken) return null

    return {
      chainId: typeof parsed.chainId === 'number' ? parsed.chainId : undefined,
      sellToken: parsed.sellToken || undefined,
      buyToken: parsed.buyToken || undefined,
      amount: parsed.amount || undefined,
      field: parsed.field === 'buy' ? 'buy' : 'sell',
      ts: parsed.ts,
    }
  } catch {
    return null
  }
}

export function clearIntentStash(): void {
  try {
    sessionStorage.removeItem(INTENT_STASH_KEY)
  } catch {
    // ignore
  }
}
