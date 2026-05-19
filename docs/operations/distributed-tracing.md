# Distributed tracing — orderbook ↔ autopilot ↔ driver ↔ solvers

**Status as of 2026-05-19:** code wiring is complete; export to a collector
is OFF (no `collector-endpoint` configured in any service's TOML). Enable
when you want it.

## What's wired

The Ophis backend uses `tracing` + `tracing-opentelemetry` end-to-end:

1. **HTTP server side** (orderbook, driver, autopilot): a tower-http
   `TraceLayer` wraps every route. On every incoming request, the
   `make_span` middleware in `observe::tracing::distributed::axum`:
   - Extracts the W3C `traceparent` header via the
     `TraceContextPropagator` (set globally in `observe::tracing::init`).
   - Sets the request span's parent context to the extracted trace.
   - Records the request ID + URI + method.

2. **HTTP client side** (autopilot → driver, driver → solvers,
   solvers → DEX APIs): every outbound `reqwest` call attaches
   `tracing_headers()`, which injects the current span's trace context
   into the headers (`traceparent`, `tracestate`).

3. **Log correlation**: when an OTel collector is configured, every
   tracing event emitted under a span carries a `trace_id` field
   (formatted by `TraceIdJsonFormat` / `TraceIdFmt`). You can grep
   journald / Loki for a specific trace_id and find every log line
   from every service that participated in that request.

## What's NOT wired (intentional, until you want it)

- **Export to a collector.** `TracingConfig.collector_endpoint` is
  `Option<String>` in `crates/configs/src/shared.rs:51`. Default is
  `None`, which means the OTel SDK creates spans in memory but never
  ships them to a backend. Logs still get the `trace_id` field; you
  just can't see the spans in a UI.

- **Sampling.** When the collector is on, by default 100% of requests
  are exported (Jaeger / Tempo / Honeycomb / Grafana Cloud default).
  At Ophis's traffic levels (OP-only, ~1 auction every 12s, ~5 spans
  per auction), 100% sampling produces ~36 spans/min — well under any
  free tier. No tuning needed initially.

- **Tail-based / probability sampling.** Out of scope until traffic
  warrants. Default head-based is fine.

## Enabling export (10 minutes)

### Option A — Grafana Cloud Tempo free tier (recommended)

1. Sign up for Grafana Cloud (free tier: 50GB traces, no card required
   for 14-day trial → free indefinitely after).
2. Get the OTLP HTTP endpoint URL and a bearer token from the Tempo
   data source page. Format:
   ```
   collector_endpoint = "https://otlp-gateway-prod-<region>.grafana.net/otlp"
   ```
3. Add to `~/greg/infra/optimism-mainnet/configs/autopilot.toml`:
   ```toml
   [shared.tracing]
   collector-endpoint = "https://<your tempo gateway>"
   level = "info"
   exporter-timeout = "5s"
   ```
   And mirror in `driver.toml.tmpl` and `orderbook.toml.tmpl`. (All
   three services need the same endpoint to participate in the same
   trace.)
4. Add the bearer token via env var (TODO: the current
   `TracingConfig::new` doesn't have an auth-header slot — file a
   small follow-up PR to add one if you choose this option).
5. Restart the OP stack: `docker compose restart autopilot driver orderbook`.
6. Verify: in Grafana Cloud → Explore → Tempo, search for service
   `cow_tracing`. You should see auction lifecycles.

### Option B — Self-hosted Jaeger (zero external dependency)

```bash
docker run -d \
  --name jaeger \
  --network optimism-mainnet_default \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

Then:
```toml
[shared.tracing]
collector-endpoint = "http://jaeger:4317"
level = "info"
```

UI at <http://localhost:16686>. Storage in-memory by default → traces lost
on Jaeger restart. Fine for debugging, not for production.

### Option C — Honeycomb / DataDog / Sentry

All accept OTLP HTTP. Same `collector-endpoint` + auth pattern as Grafana.

## Sample trace (what to expect)

A successful auction settle on OP looks like (rough sketch):

```
orderbook::POST /api/v1/quote                     ──┐  500ms
  orderbook::price_estimation                       │
    └─ price-estimation::native::oneinch::fetch     │
  orderbook::create_order                           │
    └─ db::insert_order                             ┘

autopilot::run_loop::auction                      ──┐  3s
  autopilot::solvable_orders::update                │
  autopilot::solve_request → driver POST /solve   ──┼─ propagates trace
    driver::solve                                   │
      driver::solver::POST /solve (×N solvers)   ───┤
        solvers::baseline::route                    │
        solvers::kyberswap::route                   │
        solvers::okx::route                         │
        solvers::velora::route                      │
  autopilot::settle → driver POST /settle         ──┤
    driver::settle                                  │
      driver::mempool::submit                       │
        ethereum::send_raw_transaction              ┘ (out of trace; no header)
```

The submit-to-mempool boundary is where the trace ENDS — once the
signed tx hits the mempool, there's no OTel header to carry into the
on-chain world. Trace ID is recorded in autopilot's log line for the
tx_hash, so you can manually cross-reference an etherscan-side
investigation back to the trace.

## When NOT to enable

- During an incident — adding a new dependency mid-incident is
  high-risk.
- When you don't have a budget signal — Grafana free tier covers
  current volume but spiky bursts could trip you into a paid tier
  unnoticed.
- If your prod traffic isn't yet diagnostically interesting — at
  ~36 spans/min, the value-per-trace is modest. Wait until you have
  enough traffic to do statistical analysis.

## Code references

| File | Purpose |
|---|---|
| `crates/observe/src/tracing/init.rs` | OTel SDK setup + propagator install |
| `crates/observe/src/tracing/distributed/axum.rs` | Inbound HTTP span extraction |
| `crates/observe/src/tracing/distributed/headers.rs` | Outbound HTTP header injection |
| `crates/observe/src/tracing/distributed/trace_id_format.rs` | trace_id in JSON log output |
| `crates/configs/src/shared.rs` (TracingConfig) | TOML schema for collector + level + timeout |
| Call sites: `crates/driver/src/infra/solver/mod.rs:439,547` | Driver→solver outbound |
| Call sites: `crates/autopilot/src/infra/solvers/mod.rs:98,130` | Autopilot→driver outbound |
| Call sites: `crates/orderbook/src/api.rs:358` | Orderbook inbound TraceLayer |
| Call sites: `crates/driver/src/infra/api/mod.rs:158` | Driver inbound TraceLayer |
| Call sites: `crates/autopilot/src/infra/api.rs:59` | Autopilot inbound TraceLayer |
