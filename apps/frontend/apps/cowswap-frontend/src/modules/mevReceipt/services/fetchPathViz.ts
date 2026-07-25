/**
 * Best-effort fetch of an order's pathviz SVG from the Ophis orderbook.
 *
 * Gated to Optimism (chain 10), which is the only chain where the backend
 * pathviz feature is enabled. Aborts after 3 s and swallows every failure
 * (missing feature, 404, network, non-SVG body): the MEV receipt is fully
 * usable without the diagram, so this never throws and never blocks the
 * download. Returns the base64-encoded SVG, or null.
 */

/** The chain where the backend pathviz feature is live. */
export const PATH_VIZ_CHAIN_ID = 10

/** Ophis Optimism orderbook base (mirrors cowSdk `OPHIS_OP_ORDERBOOK_URL`). */
const OPHIS_OP_ORDERBOOK_URL = 'https://optimism-mainnet.ophis.fi'

const ABORT_MS = 3_000

export interface FetchPathVizParams {
  readonly orderUid: string
  readonly chainId: number
  /** Override the orderbook base URL (tests, non-prod). */
  readonly baseUrl?: string
  /** Injectable fetch for testing. */
  readonly fetchImpl?: typeof fetch
}

/** UTF-8-safe base64 of an SVG string (btoa alone mishandles non-Latin1). */
function toBase64(svg: string): string {
  // TextEncoder + binary-string bridge keeps multibyte token symbols intact.
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export async function fetchPathViz({
  orderUid,
  chainId,
  baseUrl = OPHIS_OP_ORDERBOOK_URL,
  fetchImpl = fetch,
}: FetchPathVizParams): Promise<string | null> {
  if (chainId !== PATH_VIZ_CHAIN_ID) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ABORT_MS)
  try {
    const url = `${baseUrl}/api/v1/orders/${orderUid}/pathviz.svg`
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'image/svg+xml' } })
    if (!res.ok) return null
    const svg = await res.text()
    if (!svg.includes('<svg')) return null
    return toBase64(svg)
  } catch {
    // Aborted, offline, feature disabled: the receipt stands without the diagram.
    return null
  } finally {
    clearTimeout(timer)
  }
}
