---
id: ai-agents
title: AI agent integration
description: Connect an agent to Ophis through MCP, framework adapters or the SDK.
sidebar_label: AI agents
sidebar_position: 2
---

# AI agent integration

Connect your agent to Ophis to parse requests, get quotes and build orders for wallet signing.

<Cards>
<Card icon="server" title="MCP server" href="/ai-agents#connect-your-mcp-client">Connect your client to the hosted swap tools.</Card>
<Card icon="plug" title="Framework adapters" href="/ai-agents#drop-in-framework-adapters">Use a published package to quote, sign and submit.</Card>
<Card icon="braces" title="Intent API" href="/intent-api">Turn natural language into fields for a swap link.</Card>
</Cards>

## Connect a client {/* #connect-your-mcp-client */}

The current server release is **v0.2.0**. It uses streamable HTTP and requires no API key:

```
https://mcp.ophis.fi/mcp
```

| Setting | Value |
| --- | --- |
| Request header | `Accept: text/event-stream` |
| Missing header | HTTP 406 |

<Steps>

1. **Add the server.** Use the configuration for your client below.
2. **Request a quote.** Ask the agent to "quote 100 USDC to ETH on Optimism".
3. **Review and sign.** The agent calls `resolve_token`, `get_quote` and `build_order`; sign the returned order with your wallet.

</Steps>

### Claude Code

```bash
claude mcp add --transport http ophis https://mcp.ophis.fi/mcp
```

### Claude Desktop

Add this to `claude_desktop_config.json` to use the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "ophis": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.ophis.fi/mcp"]
    }
  }
}
```

### Cursor

Add this to `~/.cursor/mcp.json` or the project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ophis": {
      "url": "https://mcp.ophis.fi/mcp"
    }
  }
}
```

### VS Code

Add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "ophis": {
      "type": "http",
      "url": "https://mcp.ophis.fi/mcp"
    }
  }
}
```

OpenAI Agents SDK, LangChain and custom clients can connect with a streamable-HTTP MCP transport.

## Main MCP tools {/* #mcp-server-recommended */}

Your MCP client lists every tool the server offers.

| Tool | Purpose |
| --- | --- |
| `parse_intent` | Parse natural language into structured fields. |
| `resolve_token` | Resolve a symbol against trusted Ophis/CoW lists; check the chain, address and ambiguity. |
| `get_quote` | Fetch an executable quote. |
| `build_order` | Build a bounded order with the receiver unconditionally pinned to the owner. |
| `submit_order` | Submit a signed order to its chain's orderbook. |
| `validate_order` | Check appCode, host, domain, appData hash and receiver for a manually built order. |
| `list_chains` | List supported chains, settlement contracts and orderbook hosts. |
| `get_balances` | Read native and ERC-20 balances on one chain. |
| `get_portfolio` | Read token balances across chains. |
| `get_integrator_earnings` | Look up the volume and fees routed under an appCode. |
| `get_gas` | Read the current gas price. |
| `get_token_chart` | Fetch an OHLCV price chart. |
| `expected_surplus` | Compare an Ophis sell quote with the open market using `beatBps`. |

MCP clients pass `referrerCode` to `build_order` for referral attribution, including on Arc.

## Build a swap link {/* #the-integration-flow */}

<Steps>

1. **Parse the request.** Send the user's text to `https://ophis.fi/api/intent`.
2. **Read the fields.** Extract `sellToken`, `buyToken`, `amount` and `chain` from the `ParsedIntent`.
3. **Build the link.** Map the chain slug to its ID and construct `https://swap.ophis.fi/#/<chainId>/swap/<sellToken>/<buyToken>`.
4. **Open the swap form.** Let the user confirm the amount, review the order and sign in their wallet.

</Steps>

| API limit | Requirement |
| --- | --- |
| Rate | 30 req/min/IP |
| Server calls | Omit the browser `Origin` header |
| Rate-limit response | Honour `429` and `Retry-After` |

### Curl example {/* #minimal-example-curl */}

```bash
curl -sS https://ophis.fi/api/intent \
  -H 'content-type: application/json' \
  -d '{"text":"swap 100 USDC for ETH on Base"}'
```

```json
{
  "ok": true,
  "data": {
    "intent": "swap",
    "entities": [
      { "type": "amount", "value": "100", "raw": "100", "start": 5, "end": 8 },
      { "type": "sellToken", "value": "USDC", "raw": "USDC", "start": 9, "end": 13 },
      { "type": "buyToken", "value": "ETH", "raw": "ETH", "start": 18, "end": 21 },
      { "type": "chain", "value": "base", "raw": "Base", "start": 25, "end": 29 }
    ]
  }
}
```

## Python helper

Use this helper to parse text and build a link. Requests without a chain default to Ethereum; unknown chain slugs raise an error.

```python
import requests

INTENT_API = "https://ophis.fi/api/intent"
SWAP_APP = "https://swap.ophis.fi"

# The 14 chain slugs returned by the Intent API.
CHAIN_SLUG_TO_ID = {
    "ethereum": 1,
    "optimism": 10,
    "bnb": 56,
    "gnosis": 100,
    "polygon": 137,
    "base": 8453,
    "ink": 57073,
    "linea": 59144,
    "arbitrum": 42161,
    "avalanche": 43114,
    "plasma": 9745,
    "unichain": 130,
    "robinhood": 4663,
    "arc": 5042,
}


def parse_intent(text: str) -> dict:
    """Call the Ophis Intent API and return the ParsedIntent payload."""
    resp = requests.post(INTENT_API, json={"text": text}, timeout=10)
    resp.raise_for_status()
    body = resp.json()
    if not body["ok"]:
        raise RuntimeError(f'{body["error"]["code"]}: {body["error"]["message"]}')
    return body["data"]


def build_deeplink(parsed: dict) -> str:
    """Turn a ParsedIntent into a swap deep link for the user to sign."""
    by_type = {e["type"]: e["value"] for e in parsed["entities"]}
    sell = by_type.get("sellToken", "_")
    buy = by_type.get("buyToken", "_")
    chain_slug = by_type.get("chain")
    if chain_slug is None:
        chain_id = 1  # no chain in the request -> default to Ethereum
    elif chain_slug in CHAIN_SLUG_TO_ID:
        chain_id = CHAIN_SLUG_TO_ID[chain_slug]
    else:
        # Reject unmapped chains to prevent wrong-chain links.
        raise ValueError(f"unmapped chain slug {chain_slug!r}; update CHAIN_SLUG_TO_ID")
    # The user sets/confirms the amount and signs in the app.
    return f"{SWAP_APP}/#/{chain_id}/swap/{sell}/{buy}"


intent = parse_intent("swap 100 USDC for ETH on Base")
print(build_deeplink(intent))  # https://swap.ophis.fi/#/8453/swap/USDC/ETH
```

## LangChain tool

Wrap the helper as a [LangChain](https://python.langchain.com) tool:

```python
from langchain_core.tools import tool


@tool
def ophis_swap_intent(text: str) -> dict:
    """Parse a natural-language swap request into a structured Ophis intent
    and a deep link the user can open to review and sign. Use this
    whenever a user wants to swap, buy, or sell a crypto token.
    Show the link to the user for wallet signing."""
    parsed = parse_intent(text)
    return {"intent": parsed, "deeplink": build_deeplink(parsed)}
```

## Function calling {/* #autogpt--function-calling-agents */}

Register this schema with AutoGPT, OpenAI Assistants or a custom function-calling loop:

```json
{
  "type": "function",
  "function": {
    "name": "ophis_parse_intent",
    "description": "Parse a natural-language crypto swap request into a structured intent (sellToken, buyToken, amount, chain). Returns a deep link the user opens to review and sign.",
    "parameters": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "The swap request in natural language, e.g. 'swap 100 USDC for ETH on Base'. Max 280 characters."
        }
      },
      "required": ["text"]
    }
  }
}
```

The handler posts `{ "text": <text> }` to `https://ophis.fi/api/intent`, then returns the parsed fields and swap link using the Python helper.

## Framework adapters {/* #drop-in-framework-adapters */}

The v0.3.7 adapter family is built and published against `@ophis/sdk` v0.4.5. These packages quote, sign EIP-712 orders, approve the relayer and submit using the agent's wallet:

| Package | Version | Framework | Entry point |
| --- | --- | --- | --- |
| [`@ophis/agentkit-ophis`](https://www.npmjs.com/package/@ophis/agentkit-ophis) | v0.3.7 | [Coinbase AgentKit](https://github.com/coinbase/agentkit) | `OphisActionProvider_swap` |
| [`@ophis/plugin-goat`](https://www.npmjs.com/package/@ophis/plugin-goat) | v0.3.7 | [GOAT SDK](https://github.com/goat-sdk/goat) | `ophis_swap` |
| [`@ophis/plugin-elizaos`](https://www.npmjs.com/package/@ophis/plugin-elizaos) | v0.3.7 | [elizaOS](https://github.com/elizaOS/eliza) | `swap` |
| [`@ophis/agent-swap`](https://www.npmjs.com/package/@ophis/agent-swap) | v0.3.7 | Custom EOA frameworks | `executeOphisSwap()` |

| Requirement | Value |
| --- | --- |
| Assets | ERC-20 to ERC-20; wrap native ETH to WETH before using an adapter |
| Owner and receiver | The agent's wallet |
| AgentKit and GOAT inputs | `sellToken`, `buyToken`, `sellAmount` in whole units, such as `"1.5"` |
| Optional slippage | `slippageBps`, default `50` = 0.5% |
| elizaOS input | Tokens and amount from the user's message; default 0.5% slippage |
| Result | Order UID and explorer URL |
| Arc support | Core and AgentKit accept an Arc wallet with ERC-20 addresses; use GOAT and elizaOS on their listed chains |

### Coinbase AgentKit

```ts
import { AgentKit } from '@coinbase/agentkit';
import { ophisActionProvider } from '@ophis/agentkit-ophis';

const agentKit = await AgentKit.from({
  walletProvider, // your EvmWalletProvider
  actionProviders: [ophisActionProvider()],
});
```

### GOAT SDK

```ts
import { ophis } from '@ophis/plugin-goat';

const tools = await getOnChainTools({
  wallet: viem(walletClient),
  plugins: [ophis({})],
});
```

### elizaOS

The agent signs with its `EVM_PRIVATE_KEY`:

```ts
import { ophisPlugin } from '@ophis/plugin-elizaos';

export const character = {
  name: 'Trader',
  plugins: [ophisPlugin], // registers a natural-language `swap` action
};
```

## Adapter fees

Adapters select the stable-pair policy from a verified stablecoin list.

| Fee | Amount |
| --- | --- |
| Base | 1 bp on every supported pair |
| Reference-quote improvement | 50% capped at 20 bps for stable pairs, versus 80% capped at 99 bps for volatile pairs |

See [Fees](/fees) for the chain-specific policy and [Security and audits](/audits) for review coverage.

## Shell agent skills {/* #markdown-skill-family-shell-capable-agents */}

Use [`@ophis/agent-skills`](https://www.npmjs.com/package/@ophis/agent-skills)
v0.1.1 for runtimes with a shell, `curl`, `jq` and Foundry's `cast`.

| Resource | Use |
| --- | --- |
| [Skill index](https://ophis.fi/.well-known/agent-skills/index.json) | Download files and verify their sha256 digests. |
| [Umbrella skill](https://ophis.fi/.well-known/agent-skills/ophis/SKILL.md) | Read contract addresses, signing domains, orderbook hosts and slippage limits. |
| Sub-skills | `ophis-quote`, `ophis-swap`, `ophis-order-status`, `ophis-cancel`, `ophis-surplus-report` |
| Skill chains | Optimism, Unichain and Robinhood Chain |

Use MCP `list_chains` for supported networks beyond the shell skills.

## Build SDK orders {/* #submitting-orders-programmatically */}

**`@ophis/sdk`**, published on npm (v0.4.5, public), builds orders for the [CoW Protocol orderbook API](https://docs.cow.fi/cow-protocol/reference/apis/orderbook). Install it with `npm install @ophis/sdk`.

<Steps>

1. **Resolve the host.** Use the chain ID to select the orderbook.

   ```typescript
   import { getOphisOrderbookUrl } from '@ophis/sdk';

   const orderbookUrl = getOphisOrderbookUrl(10); // -> https://optimism-mainnet.ophis.fi
   const arcOrderbookUrl = getOphisOrderbookUrl(5042); // -> https://arc-mainnet.ophis.fi
   // Throws on an invalid or unsupported chainId rather than guessing a host.
   ```

2. **Build the appData.** Use the fee helper and cow-sdk's deterministic serializer before hashing; keep hooks empty.

   ```typescript
   import { MetadataApi, stringifyDeterministic } from '@cowprotocol/cow-sdk';
   import { keccak256, toUtf8Bytes } from 'ethers';
   import { buildOphisAppDataPartnerFee } from '@ophis/sdk';

   // The chain ID selects the fee policy.
   const partnerFee = buildOphisAppDataPartnerFee(10);
   // -> { volumeBps: 1, recipient }

   const metadataApi = new MetadataApi();
   const doc = await metadataApi.generateAppDataDoc({
     appCode: 'ophis',
     metadata: {
       partnerFee,
       hooks: {}, // pin empty, appData hooks are arbitrary on-chain calls
     },
   });
   const fullAppData = await stringifyDeterministic(doc);
   const appDataHash = keccak256(toUtf8Bytes(fullAppData)); // bytes32 -> order.appData
   ```

3. **Pin the receiver.** Check that bought tokens go to the order owner before signing.

   ```typescript
   import { assertReceiverIsOwner } from '@ophis/sdk';

   assertReceiverIsOwner(owner, order.receiver); // throws if receiver !== owner
   ```

4. **Sign the typed data.** Use `signTypedData` with the chain-specific domain and `Order` type.

   ```typescript
   import { getOphisOrderDomain } from '@ophis/sdk';

   // The EIP-712 primary type is Order.
   const ORDER_TYPES = {
     Order: [
       { name: 'sellToken', type: 'address' },
       { name: 'buyToken', type: 'address' },
       { name: 'receiver', type: 'address' },
       { name: 'sellAmount', type: 'uint256' },
       { name: 'buyAmount', type: 'uint256' },
       { name: 'validTo', type: 'uint32' },
       { name: 'appData', type: 'bytes32' },
       { name: 'feeAmount', type: 'uint256' },
       { name: 'kind', type: 'string' },
       { name: 'partiallyFillable', type: 'bool' },
       { name: 'sellTokenBalance', type: 'string' },
       { name: 'buyTokenBalance', type: 'string' },
     ],
   };

   // ethers v6: resolve the domain for Optimism.
   const signature = await wallet.signTypedData(getOphisOrderDomain(10), ORDER_TYPES, order);
   ```

5. **Submit the order.** Send the signed order to the resolved orderbook.

</Steps>

:::warning[Check the receiver before signing]

A different `receiver` sends the bought tokens to another account. Run `assertReceiverIsOwner` before authorizing the order.

:::

| Chain | Orderbook host | Settlement |
| --- | --- | --- |
| Optimism | `optimism-mainnet.ophis.fi` | `0x310784c7…B859` |
| Unichain | `unichain-mainnet.ophis.fi` | `0x108A678716e5E1776036eF044CAB7064226F714E` |
| Robinhood Chain | `robinhood-mainnet.ophis.fi` | `0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD` |
| Arc (5042) | `arc-mainnet.ophis.fi` | `0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A` |

`getOphisOrderDomain` selects the settlement for signing. `getOphisOrderbookUrl` selects the matching submission host.

For manual fee construction, use `ophisVolumeBpsForChainAndPair(chainId, isStablePair)` and the CIP-75 volume shape. The price-improvement shape uses a different denominator. Use `stringifyDeterministic` to produce the appData hash expected by solvers.

## Wallet controls {/* #autonomous-agent-trading-advanced */}

Use [Turnkey wallet policies](/agent-wallet-policies) to pin the signer to the settlement domain, your token allowlist and your receiver address. Approve bounded sell-token amounts and keep a guardian key that can revoke signing.

## Next

<Cards>
<Card icon="lock" title="Wallet policies" href="/agent-wallet-policies">Configure Turnkey signing restrictions.</Card>
<Card icon="scale" title="Order controls" href="/agent-swap-comparison">Review signed limits and settlement fees.</Card>
<Card icon="code" title="SDK integration" href="/partners">Use the SDK's order-building helpers.</Card>
</Cards>
