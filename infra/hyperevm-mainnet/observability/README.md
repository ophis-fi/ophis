# Ophis HyperEVM — Observability Stack

Prometheus + Alertmanager containers that scrape the HL stack's `/metrics`
endpoints and page Clement via Telegram when things break.

## Files

| File | Purpose | Contains secrets? |
|---|---|---|
| `prometheus.yml` | Scrape config (driver/autopilot/orderbook/rpc-proxy). | No |
| `alerts.yml` | 10 Prometheus alert rules (4 availability, 4 settlement-health, 2 latency). | No |
| `alertmanager.yml.tmpl` | Alertmanager routing + Telegram receivers. Rendered at deploy time. | Token via file mount (no in-config) |

At deploy time `../render-configs.sh` writes:
- `../observability-rendered/alertmanager.yml` — `${TELEGRAM_BOT_TOKEN}` substituted nowhere (config refers to `bot_token_file`).
- `../observability-rendered/telegram-token` — chmod 600, mounted into Alertmanager as `/etc/alertmanager/telegram-token`.

## Telegram bot

- Bot: **@clawdiusfranciscus_bot** (Clement's own bot, not Stuart's)
- Chat ID: **735726338** (Clement's DM)
- Token source: `python3 -c "import json;print(json.load(open('/Users/scep/.kimi/kimi-claw/openclaw.json'))['channels']['telegram']['botToken'])"` (legacy path — was `~/.openclaw/openclaw.json` until OpenClaw was decommissioned).

## Alerts

### Critical (page immediately, repeat 30m)
- `OphisHlAutopilotDown` — autopilot:9589 not scraping for 5m
- `OphisHlDriverDown` — driver:80 not scraping for 5m
- `OphisHlOrderbookDown` — orderbook:9586 not scraping for 5m
- `OphisHlERPCDown` — rpc-proxy:4000 not scraping for 3m
- `OphisHlNoSettlements1h` — 0 successful settlements in 1h while auctions still ticking
- `OphisHlSettlementFailureRateHigh` — settlement failures > 5% over 15m

### Warning (notify, repeat 4h)
- `OphisHlMempoolSubmissionFailing` — mempool failures > 10% over 15m
- `OphisHlSolverDropRateHigh` — per-solver dropped > 50% over 15m
- `OphisHlAuctionLatencyHigh` — p95 auction preprocessing > 5s for 10m
- `OphisHlSolveTimeBudgetExhausted` — dispatched solvers receive <1s p99 over 10m

## Post-deploy smoke test

```bash
# 1. Prometheus scraping all 4 targets
curl -s http://127.0.0.1:9090/api/v1/targets | \
  jq -r '.data.activeTargets[] | "\(.job) \(.health) \(.scrapeUrl)"'
# Expected: driver/autopilot/orderbook/rpc-proxy all `up`.

# 2. Alertmanager loaded its config
curl -s http://127.0.0.1:9093/api/v2/status | jq '.config.original' | head -20

# 3. Send a synthetic "test" alert to validate Telegram delivery
curl -s -XPOST http://127.0.0.1:9093/api/v2/alerts \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {
      "alertname": "OphisObservabilityDeployTest",
      "severity": "warning",
      "chain": "hyperevm"
    },
    "annotations": {
      "summary": "Observability deploy smoke test",
      "description": "If you see this on Telegram, the alertmanager → @clawdiusfranciscus_bot path works."
    },
    "generatorURL": "http://localhost:9090"
  }]'
# Wait 30s (group_wait for warnings) → expect a Telegram DM to Clement.
# After confirming, resolve:
curl -s -XPOST http://127.0.0.1:9093/api/v2/alerts \
  -H "Content-Type: application/json" \
  -d '[{
    "labels": {"alertname":"OphisObservabilityDeployTest","severity":"warning","chain":"hyperevm"},
    "annotations": {"summary":"resolved","description":"resolved"},
    "endsAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }]'
```

## Why this is a precondition for direct V3 liquidity wiring (task #120)

Adding direct UniV3 liquidity sources (Project X, HyperSwap V3, Hybra V3)
adds stateful, RPC-heavy components to the driver. A misconfigured pool,
factory address drift, or RPC quota exhaustion would silently degrade
settlement reliability — currently we'd notice via on-chain reverts +
manual log inspection, which can be hours of MTTD.

With this stack in place:
- `OphisHlSolverDropRateHigh` fires within 15m of any solver-side pool
  regression.
- `OphisHlSettlementFailureRateHigh` fires within 10m of revert-causing
  pool state.
- `OphisHlAuctionLatencyHigh` fires when V3 polling saturates the eRPC
  quota.

Once this stack is deployed + the synthetic test alert reaches Clement,
task #120 is unblocked.
