# Ophis natural-language swap-intent input — design

**Status:** approved 2026-05-08
**Successor to:** Phase 2.6 brand foundations (`2026-05-06-ophis-brand-foundations.md`, `2026-05-07-ophis-brand-guidelines.md`)
**Codename note:** the project is being rebranded Ophis → Ophis; this spec uses the new name throughout. The mascot is **Ophie** (ouroboros).

## 1. Goal

Replace the current `/` (which redirects to `/#/swap`) with an Ophis landing page whose hero is a natural-language input. Users describe what they want to swap in plain English ("100 USDC for ETH on Base"); the page parses it in real-time, highlights recognized entities inline with their logos, and on confirmation slides into the existing cowswap swap UI with the form pre-filled.

The first-time UX should feel "I just told it what I want" rather than "I'm filling out a DEX form".

### Non-goals (V1)

- Hybrid local-regex preview (deferred to V2 pending telemetry).
- Multi-leg, limit, TWAP, DCA, or conversational-refinement intents — V1 covers spot swaps only.
- Auto-slide on idle — V1 requires explicit Continue/Enter.
- Mobile virtual-keyboard polish — will function, not optimized.
- Replacement of the swap UI itself — cowswap's existing form is the destination, untouched.

## 2. UX flow

1. **Land on `/`** — Ophis wordmark (top-left), connect-wallet (top-right). Center: Ophie mascot above a Fraunces tagline ("Tell us what to swap"), the intent input, three clickable example chips, a small "Skip to manual swap →" link below.
2. **User types.** After 400ms of no keystrokes, a debounced parse fires.
3. **Spinner appears** at the right edge of the input. ~700ms later (LibertAI Qwen 3.5 122B median), response lands.
4. **Entities visually replace their raw substrings inline** — `USDC` becomes a `[USDC-logo] USDC` chip, `Base` becomes `[Base-logo] Base` chip. Brand-coral border, brand-neutral fill.
5. **Below the input** a small pill row reflects the parsed structure: e.g. `[100] sell [USDC] buy [ETH] on [Base]`.
6. **Continue → button**: greyed by default; transitions to coral the moment `intent === "swap"` with at least one token entity. Enter on the input has the same effect.
7. **On submit**: brief OphieSpinner overlay → page transitions left, the existing cowswap swap UI slides in from the right with the form pre-populated from extracted entities. URL becomes `/#/swap?…`.
8. **User signs in cowswap** (its existing approval/order-sign flow). Done.

## 3. Architecture

```
Browser (Cloudflare Pages SPA)
  │
  │  POST /api/intent
  │  body: { "text": "100 USDC for ETH on Base" }
  ▼
Cloudflare Pages Function  (functions/api/intent.ts)
  │  - holds LIBERTAI_API_KEY as a CF env secret
  │  - calls api.libertai.io /v1/chat/completions
  │  - locked system prompt (see §4)
  │  - 5 s timeout, structured error envelope on failure
  │  - returns parsed JSON to the browser
  │
  ▼
api.libertai.io  (Qwen 3.5 122B, OpenAI-compatible, Bearer auth)
```

The browser never sees the API key. The Function is the only surface that knows it. Each parse is stateless — no Liberclaw-style chat session; the Function constructs a one-shot system+user message every call.

The existing CF Pages deploy (`.github/workflows/cloudflare-deploy.yml` → `greg-etm.pages.dev`) gains a `functions/` directory at the repo root. Wrangler/CF Pages auto-discovers it. `LIBERTAI_API_KEY` is added as a CF secret via the Cloudflare dashboard or `wrangler pages secret put`.

## 4. Data contracts

### 4.1 System prompt (locked, copied from validated tests)

```
You parse natural-language swap requests for Ophis, an intent-based DEX
aggregator. Given user text, return ONLY a single JSON object, no prose,
no markdown fences.

Schema:
{
  "intent": "swap" | "unknown",
  "entities": [
    {
      "type": "sellToken" | "buyToken" | "amount" | "chain",
      "value": "<canonical>",
      "raw":   "<exact substring>",
      "start": <int>,
      "end":   <int>
    }
  ]
}

Rules:
- Token canonical values: uppercase symbols (USDC, ETH, WETH, USDT, DAI).
  "ether" -> ETH. "wrapped eth" -> WETH. "stables"/"stablecoin" -> omit.
- Chain canonical values: lowercase slugs (ethereum, optimism, base,
  arbitrum, polygon, avalanche, gnosis, linea, bnb, megaeth).
  "eth mainnet"/"l1" -> ethereum. "op" -> optimism. "polygon pos" -> polygon.
- Amount: numeric string only ("100", "1.5"). "a hundred" -> "100". No units.
- ETH disambiguation: chain only when preceded by "on"/"via"/"using";
  otherwise it is a token.
- Unknown tokens/chains: OMIT, do not invent.
- start/end are 0-indexed character offsets in the original input.
  start inclusive, end exclusive.
- If the input is not a swap request, return {"intent":"unknown","entities":[]}.
- Output ONLY the JSON.
```

LibertAI request body shape:

```json
{
  "model": "qwen3.5-122b-a10b",
  "temperature": 0,
  "max_tokens": 400,
  "messages": [
    { "role": "system", "content": "<the prompt above>" },
    { "role": "user",   "content": "<user input>" }
  ]
}
```

### 4.2 Function response envelope

```ts
type IntentResponse =
  | { ok: true;  data: ParsedIntent }
  | { ok: false; error: { code: 'TIMEOUT' | 'UPSTREAM' | 'INVALID_JSON' | 'BAD_INPUT'; message: string } }

type ParsedIntent = {
  intent: 'swap' | 'unknown'
  entities: Entity[]
}

type Entity = {
  type: 'sellToken' | 'buyToken' | 'amount' | 'chain'
  value: string
  raw: string
  start: number
  end: number
}
```

The Function validates the LLM output as JSON-conforming to `ParsedIntent` before returning. Malformed → `INVALID_JSON` error rather than passing garbage through.

### 4.3 Pre-fill mapping → cowswap URL

| Entity            | URL param                         | Default if missing                            |
|-------------------|-----------------------------------|-----------------------------------------------|
| `chain`           | `chainId=<id>`                    | Cowswap falls back to wallet chain.           |
| `sellToken`       | `inputCurrency=<symbol>`          | Empty (cowswap leaves field unfilled).        |
| `buyToken`        | `outputCurrency=<symbol>`         | Empty.                                        |
| `amount`          | `exactAmount=<n>&exactField=input`| No amount param emitted.                      |

Submit transitions to `/#/swap?<params>`. Cowswap's existing token-list resolver maps `inputCurrency=USDC` to the right per-chain address; the chain-mismatch banner ("switch to Base") is its existing flow — we don't reimplement it.

Chain slug → chainId table (V1 set):

| Slug      | chainId  |
|-----------|----------|
| ethereum  | 1        |
| optimism  | 10       |
| base      | 8453     |
| arbitrum  | 42161    |
| polygon   | 137      |
| avalanche | 43114    |
| gnosis    | 100      |
| linea     | 59144    |
| bnb       | 56       |
| megaeth   | 4326     |

## 5. Components

All new components live in `apps/frontend/apps/cowswap-frontend/src/ophis/components/intent/`.

| File                | Role                                                                                                                                              |
|---------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `IntentLanding.tsx` | Full landing page. Routes-mounted at `/`. Hosts mascot, tagline, `IntentInput`, `ExampleChips`, skip-link.                                        |
| `IntentInput.tsx`   | Layered text input. Plain `<input type="text">` captures keystrokes (a11y/IME-safe). An absolutely-positioned overlay `<div>` renders the same value with `<EntityChip>` spans replacing entity raw substrings. Both scroll-synced. Sub-component: `IntentInputOverlay`. |
| `EntityChip.tsx`    | Token/chain logo + canonical label. Reuses cowswap's `TokenLogo` for tokens; chain icon reuses cowswap's existing chain-icon component if one exists, else a small new map (discovery item for the implementation plan). |
| `ExampleChips.tsx`  | Three preset prompts. Click pre-fills the input + triggers immediate parse. V1 set:<br>• "Swap 100 USDC for ETH on Base"<br>• "Trade ETH for stables on Optimism"<br>• "Buy 1000 USDT on Arbitrum" |
| `useIntentParse.ts` | Hook. Owns: 400ms debounce, abortable fetch to `/api/intent`, loading / result / error state, retry on stale request via `AbortController`.        |
| `intentToUrl.ts`    | Pure function. `(ParsedIntent) => string` returning the `/#/swap?…` URL using §4.3.                                                              |

Reused, untouched:
- `src/ophis/ophiePath.ts` — mascot SVG.
- `src/ophis/components/OphieMark.tsx`, `OphieSpinner.tsx`.
- `src/ophis/tokens.ts` — color, font, spacing tokens.
- Cowswap's `TokenLogo`, route table, `<HashRouter>`, swap form.

### 5.1 Routing patch

Cowswap upstream redirects `/` → `/#/swap`. We insert a divergence in the route tree (cowswap-frontend `MainContent.tsx` or equivalent) that maps `/` to `<IntentLanding />`, with `/#/swap` still reachable directly. The "Skip to manual swap →" link in IntentLanding navigates to `/#/swap`. Documented in `apps/frontend/.ophis-divergences.md`.

## 6. Failure handling

| Failure                         | Behavior                                                                                                                                       |
|---------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| LLM > 5 s (Function timeout)    | Function returns `{ ok: false, error: { code: 'TIMEOUT' } }`. UI shows "Couldn't read that — try the manual swap" with the skip link emphasized. Continue stays disabled. |
| LibertAI 5xx / network error    | Same as TIMEOUT, error code `UPSTREAM`.                                                                                                       |
| LLM returns non-JSON or schema-violating output | Function returns `INVALID_JSON`. Same UI fallback.                                                                                       |
| `intent === "unknown"` (model decided it isn't a swap) | Continue stays grey. Helper line under input: "Try: 'swap [amount] [token] for [token] on [chain]'". No transition.                 |
| Symbol resolves but is not in cowswap's per-chain token list | URL is built and we navigate; cowswap's existing "unknown token / no liquidity" UI takes over. We do not pre-validate.            |
| User submits with no entities (Enter on empty input) | Continue is disabled, Enter is no-op. No request sent.                                                                                  |
| Concurrent parses (user keeps typing while a parse is in-flight) | Stale parse aborted via `AbortController`. Only the most recent typed value is reflected in highlights.                          |

## 7. Performance targets

| Metric                                                      | Target          |
|-------------------------------------------------------------|-----------------|
| Time from keystroke pause to highlights visible             | < 1.2 s p50     |
| Function cold start (CF Pages global)                       | < 50 ms         |
| LibertAI median round-trip (measured on 7 inputs 2026-05-08)| ~ 700 ms        |
| Bundle size delta (added components, no new heavy deps)     | < 30 KB gzipped |

If LibertAI median latency degrades > 1500 ms p95, V2 hybrid (local regex preview + LLM canonical) is the contingency.

## 8. Telemetry (V1, minimal)

Cloudflare Function logs:
- `intent.parse.ok` with `latency_ms`, `entity_count`, `intent` (swap|unknown).
- `intent.parse.error` with `code`, `latency_ms`.

No PII (the `text` field is not logged). Browser-side: standard CF Pages analytics on `/` route hits, `Continue` click event, `skip` click event.

## 9. Out of scope

- Hybrid local-regex preview (V2 if telemetry signals).
- Multi-leg / limit / TWAP / DCA / conversational-refinement intents.
- Auto-slide on idle.
- Mobile virtual-keyboard polish.
- Native iOS/Android keyboard quirks.
- Internationalization (V1 is English-only).
- Caching identical user inputs at the Function layer (LLM is cheap enough; revisit if bills become real).

## 10. Sources

- [`2026-05-06-ophis-brand-foundations.md`](2026-05-06-ophis-brand-foundations.md) — token system & rationale.
- [`2026-05-07-ophis-brand-guidelines.md`](2026-05-07-ophis-brand-guidelines.md) — Ophie mascot usage.
- LibertAI [`/v1/chat/completions`](https://api.libertai.io/docs) — OpenAI-compatible endpoint, Bearer auth.
- LibertAI Qwen 3.5 122B smoke-test results (2026-05-08): 7 representative inputs, 100% schema-conforming JSON, 0.36–1.03 s latency.
- Cowswap upstream — URL params (`inputCurrency`, `outputCurrency`, `chainId`, `exactField`, `exactAmount`) and wallet-chain-mismatch flow.
