/** @jsxImportSource preact */
import { useState } from 'preact/hooks'

const samples = {
  curl: `# Parse a natural-language swap intent
curl -X POST https://swap.ophis.fi/api/intent \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "swap 100 USDC for ETH on Optimism"
  }'

# Successful response is wrapped in { ok, data }:
# {
#   "ok": true,
#   "data": {
#     "intent": "swap",
#     "entities": [
#       { "type": "amount",    "value": "100",     "raw": "100",     "start": 5,  "end": 8 },
#       { "type": "sellToken", "value": "USDC",    "raw": "USDC",    "start": 9,  "end": 13 },
#       { "type": "buyToken",  "value": "ETH",     "raw": "ETH",     "start": 18, "end": 21 },
#       { "type": "chain",     "value": "optimism","raw": "Optimism","start": 25, "end": 33 }
#     ]
#   }
# }`,
  JavaScript: `// Parse a natural-language swap intent
const res = await fetch('https://swap.ophis.fi/api/intent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: 'swap 100 USDC for ETH on Optimism',
  }),
})
const { ok, data } = await res.json()
if (!ok) throw new Error('intent parse failed')

const { intent, entities } = data
// Build a deep link to the swap UI:
// /1/swap/USDC/ETH?sellAmount=100  (chain inferred from entities.chain)`,
  Rust: `// Parse a natural-language swap intent
let body = serde_json::json!({
  "text": "swap 100 USDC for ETH on Optimism"
});
let parsed: serde_json::Value = reqwest::Client::new()
  .post("https://swap.ophis.fi/api/intent")
  .json(&body)
  .send()
  .await?
  .json()
  .await?;

// parsed.ok == true
// parsed.data.intent == "swap"
// parsed.data.entities holds {type, value, raw, start, end} per token/chain/amount.`,
} as const

type Tab = keyof typeof samples
const tabs: Tab[] = ['curl', 'JavaScript', 'Rust']

export default function CodeTabs() {
  const [active, setActive] = useState<Tab>('curl')
  return (
    <div class="code-frame">
      <div class="tabs" role="tablist">
        {tabs.map(t => (
          <button
            class={`tab ${active === t ? 'active' : ''}`}
            role="tab"
            aria-selected={active === t}
            onClick={() => setActive(t)}
            type="button"
          >
            {t}
          </button>
        ))}
      </div>
      <pre class="code-body"><code>{samples[active]}</code></pre>
    </div>
  )
}
