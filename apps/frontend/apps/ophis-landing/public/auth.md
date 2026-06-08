# Authentication for agents

**Ophis requires no authentication.** It is a non-custodial, intent-based DEX
aggregator. There is no user account, no login, no API key, and no OAuth or
OIDC flow, by design.

## Why there is no auth

The trust boundary is the user's wallet signature, not a server-side session.
Orders are signed locally (EIP-712) in the user's own wallet and submitted as
off-chain intents with a hard limit price. Ophis never holds keys or funds and
cannot move, freeze, or recover them. There is therefore nothing to
authenticate against and no protected resource to obtain a token for.

## Public endpoints (no registration, no key)

- **Intent API:** `POST https://ophis.fi/api/intent` (natural language to a
  structured intent). Rate limited to 30 requests/min/IP. Spec:
  `https://ophis.fi/openapi.json`.
- **MCP server:** `https://mcp.ophis.fi/mcp` (discovery at
  `https://ophis.fi/.well-known/mcp.json`). Six public tools: parse_intent,
  get_quote, build_order, submit_order, lookup_tier, list_chains.
- **Agent skills index:** `https://ophis.fi/.well-known/agent-skills/index.json`
- **Plugin manifest:** `https://ophis.fi/.well-known/ai-plugin.json`
- **API catalog (RFC 9727):** `https://ophis.fi/.well-known/api-catalog`

## Registration

None required. Begin calling the public endpoints above directly, subject to the
per-IP rate limit. To place an order, build it (`build_order`), sign it in the
user's wallet, and submit it (`submit_order`). The signature, not a credential,
authorizes the trade.

Ophis intentionally does not implement HTTP-native payment automation (e.g.
x402); funds only move via a wallet-signed on-chain settlement.
