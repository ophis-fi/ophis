/**
 * Wire types for GET {orderbook}/api/v1/orders/{uid}/pathviz, matching the
 * backend's serde output (camelCase, absent optionals OMITTED, not null):
 * apps/backend/crates/orderbook/src/api/get_order_pathviz.rs and
 * apps/backend/crates/model/src/pathviz.rs. Schema v1 is labelled EXPERIMENTAL
 * by the backend, which is one more reason the parser below is total.
 */

export type PathVizNodeKind = 'token' | 'solver' | 'venue'

export interface PathVizNode {
  readonly id: string
  /** HOSTILE input (on-chain symbols / registry labels). Render as TEXT only. */
  readonly label: string
  readonly kind: PathVizNodeKind
}

export interface PathVizGraph {
  readonly nodes: readonly PathVizNode[]
}

export type PathVizContext = 'quotedOnly' | 'executing' | 'traded'

export interface PathVizResponse {
  readonly context: PathVizContext
  readonly graph: PathVizGraph
  /** Present when pathVizImage=true was requested AND the render succeeded. */
  readonly svgBase64?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const NODE_KINDS: readonly string[] = ['token', 'solver', 'venue']
const CONTEXTS: readonly string[] = ['quotedOnly', 'executing', 'traded']

/**
 * Total parser: any shape that does not match yields null rather than throwing.
 * Third-party-adjacent data (the graph carries on-chain strings) reaching a
 * render path gets checked field by field, same doctrine as
 * `parseDefillamaPriceChart`. Unknown extra fields are ignored, so a v1.x
 * additive schema change degrades to "still works" instead of "blank panel".
 */
export function parsePathVizResponse(body: unknown): PathVizResponse | null {
  if (!isRecord(body)) return null

  const { context, graph, svgBase64 } = body
  if (typeof context !== 'string' || !CONTEXTS.includes(context)) return null
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) return null

  const nodes = graph.nodes.reduce<PathVizNode[]>((acc, node) => {
    if (!isRecord(node)) return acc
    const { id, label, kind } = node
    if (typeof id !== 'string' || typeof label !== 'string') return acc
    if (typeof kind !== 'string' || !NODE_KINDS.includes(kind)) return acc

    acc.push({ id, label, kind: kind as PathVizNodeKind })
    return acc
  }, [])

  // svgBase64 must be a base64 payload we can safely embed in a data URI. The
  // charset check is cheap and stops a malformed value producing a broken img
  // src; content safety comes from <img> being a replaced element, not from
  // trusting this string.
  const svg =
    typeof svgBase64 === 'string' && svgBase64.length > 0 && /^[A-Za-z0-9+/=]+$/.test(svgBase64) ? svgBase64 : undefined

  return { context: context as PathVizContext, graph: { nodes }, svgBase64: svg }
}
