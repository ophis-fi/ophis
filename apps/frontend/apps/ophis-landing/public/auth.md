# Authentication for agents

**The public Intent API and MCP trading tools require no API key.** Wallet
signatures authorize orders. This does not mean every Ophis service is
unauthenticated: partner dashboards and operational controls have separate access rules.

## Why there is no auth

The trust boundary is the user's wallet signature, not a server-side session.
Standard ERC-20 orders are signed locally and submitted offchain with a hard
limit price. Ophis does not hold signing keys. Native-token, bridge and OTC
flows can involve onchain deposits or escrow and separate recovery rules.
Token issuers can retain freezing or transfer restrictions independently of Ophis.

## Public endpoints (no registration, no key)

- **Intent API:** `POST https://ophis.fi/api/intent` (natural language to a
  structured intent). Rate limited to 30 requests/min/IP. Spec:
  `https://ophis.fi/openapi.json`.
- **MCP server:** `https://mcp.ophis.fi/mcp` (discovery at
  `https://ophis.fi/.well-known/mcp.json`). Fourteen public tools: parse_intent,
  resolve_token, get_quote, build_order, submit_order, lookup_tier, list_chains,
  get_balances, get_portfolio, get_gas, get_token_chart, expected_surplus,
  get_integrator_earnings, validate_order.
- **Agent skills index:** `https://ophis.fi/.well-known/agent-skills/index.json`
- **Plugin manifest:** `https://ophis.fi/.well-known/ai-plugin.json`
- **API catalog (RFC 9727):** `https://ophis.fi/.well-known/api-catalog`

## Registration

None required. Begin calling the public endpoints above directly, subject to the
per-IP rate limit. To place an order, build it (`build_order`), sign it in the
user's wallet, and submit it (`submit_order`). The signature, not a credential,
authorizes the trade.

Ophis intentionally does not implement HTTP-native payment automation (e.g.
x402). Parsing a request is not permission to move funds.
