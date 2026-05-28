/** @jsxImportSource preact */
import { useState } from 'preact/hooks'

const samples = {
  curl: `# Get a quote for 100 USDC -> WETH on Optimism
curl -X POST https://ophis.fi/api/intent \\
  -H "Content-Type: application/json" \\
  -d '{
    "intent": "swap 100 USDC for WETH on Optimism",
    "from": "0x..."
  }'

# Returns a signed order ready to relay to the Ophis settlement stack.`,
  JavaScript: `// Get a quote for 100 USDC -> WETH on Optimism
const res = await fetch('https://ophis.fi/api/intent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    intent: 'swap 100 USDC for WETH on Optimism',
    from: '0x...',
  }),
})
const order = await res.json()`,
  Rust: `// Get a quote for 100 USDC -> WETH on Optimism
let body = serde_json::json!({
  "intent": "swap 100 USDC for WETH on Optimism",
  "from": "0x...",
});
let order: serde_json::Value = reqwest::Client::new()
  .post("https://ophis.fi/api/intent")
  .json(&body)
  .send()
  .await?
  .json()
  .await?;`,
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
