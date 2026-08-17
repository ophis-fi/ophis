# Ophis Quote Lab

This crate measures Ophis-reviewed Ethereum quote fixtures without adding an
execution lane.

Safety properties:

- only `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, and `eth_call` are
  available;
- every code read and quote uses one EIP-1898 block hash with
  `requireCanonical = true`;
- a runtime code-hash mismatch is a hard failure;
- quote reverts and decode failures are recorded as measurement results;
- only exact-input observations are exposed; and
- no router calldata is accepted, built, forwarded, simulated, signed, or
  submitted.

From `apps/backend`:

```sh
cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  verify

cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  quote \
  --source ophis-fixture-fixed \
  --token-in 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  --token-out 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --amount 1000000000000000000

cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  compare \
  --source ophis-fixture-fixed \
  --source ophis-fixture-prior \
  --source ophis-fixture-current \
  --token-in 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  --token-out 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --amount 1000000000000000000

cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  matrix \
  --matrix crates/ophis-quote-lab/config/ethereum-matrix.toml \
  --source ophis-fixture-fixed \
  --source ophis-fixture-prior \
  --source ophis-fixture-current

cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  matrix \
  --matrix crates/ophis-quote-lab/config/ethereum-matrix-expanded.toml \
  --source ophis-fixture-fixed \
  --source ophis-fixture-prior \
  --source ophis-fixture-current \
  --source ophis-baseline-uniswap-v3 \
  --source ophis-baseline-uniswap-v2 \
  --source ophis-baseline-uniswap-v4

cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  series \
  --matrix crates/ophis-quote-lab/config/ethereum-matrix-expanded.toml \
  --samples 3 \
  --interval-seconds 60 \
  --source ophis-fixture-fixed \
  --source ophis-fixture-prior \
  --source ophis-fixture-current \
  --source ophis-baseline-uniswap-v3 \
  --source ophis-baseline-uniswap-v2 \
  --source ophis-baseline-uniswap-v4

cargo run -p ophis-quote-lab -- \
  --rpc-url "$ETHEREUM_RPC_URL" \
  economics \
  --matrix crates/ophis-quote-lab/config/ethereum-matrix-expanded.toml \
  --candidate ophis-fixture-fixed \
  --reference ophis-baseline-uniswap-v3 \
  --gas-price-wei 1000000000 \
  --incremental-gas 25000 \
  --incremental-gas 50000 \
  --incremental-gas 100000
```

The checked-in manifest is an evidence record, not an endorsement. Update it
only after verifying source provenance and deployed bytecode at a named block.
Matrix output is descriptive evidence; it cannot enable routing or trading.
The V3 baseline performs four read-only single-pool quote calls per case and
records the quoter's gas estimate. It is a measurement control, not a new Ophis
execution venue.
The V2 baseline performs one read-only direct two-token-path quote per case.
It does not search intermediate assets or expose execution calldata.
The V4 baseline performs four read-only hookless single-pool quote calls per
case with exact allowlisted fee and tick-spacing pairs. Hooks, multi-hop paths,
native currency, and execution calldata are excluded.
Series runs are bounded to 2–24 samples and 12–3,600 seconds between samples.
Each sample must advance to a later block; duplicate-block samples fail closed.
Economics runs value candidate improvements using a same-block V3 quote from
one wrapped-native unit to the output token. Gas price and incremental gas are
mandatory scenario inputs; the lab never presents them as measured execution
gas. Break-even gas is rounded down and gross native value is rounded down, so
the model does not overstate the candidate's margin.
