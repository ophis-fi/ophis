# Ophis / CoW + MetaMask `mm` — API reference

Endpoints/addresses from `@ophis/sdk`; `mm` command surface from `@metamask/agentic-cli` (verified against the MetaMask agent-skills docs).

## Ophis/CoW orderbook endpoints (base URL is per-chain — see chains-and-tokens.md)

| Purpose | Method + path |
|---|---|
| Quote | `POST {orderbook}/api/v1/quote` |
| Publish appData | `PUT {orderbook}/api/v1/app_data/{appDataHash}` body `{"fullAppData":"<json string>"}` |
| Submit order | `POST {orderbook}/api/v1/orders` → returns the order UID |
| Order status | `GET {orderbook}/api/v1/orders/{uid}` |
| Enroll wallet | `GET https://rebates.ophis.fi/tier/{wallet}` (idempotent; once before the first order) |

`{orderbook}` = `https://api.cow.fi/<slug>` for CoW-hosted chains, `https://optimism-mainnet.ophis.fi` (10) and `https://unichain-mainnet.ophis.fi` (130) for the Ophis-sovereign chains. Hitting api.cow.fi on OP/Unichain bypasses the Ophis solver + fee.

## The EIP-712 flow (why MetaMask is a clean fit)

MetaMask agent wallets sign real EIP-712 typed data, so — unlike a tx-only managed wallet (which needs CoW **presign**) — the order is authorized with a normal `signingScheme: "eip712"` signature:

1. Build the GPv2 order. The **signed** order carries `appData` = the **bytes32 appDataHash**; the **submitted** order carries `appData` = the **full JSON string** + a separate `appDataHash`. Backend checks `keccak256(appData) == appDataHash`.
2. Sign the EIP-712 typed data (domain `{name:"Gnosis Protocol", version:"v2", chainId, verifyingContract: Settlement}`, the fixed `Order` type set, `primaryType:"Order"`).
3. Submit with `signingScheme:"eip712"`, the `signature`, and `from` = owner. `feeAmount` is `"0"` on modern orders; `receiver` = owner.

## MetaMask `mm` CLI — the two commands this skill hinges on

```bash
# Approve GPv2VaultRelayer to spend the sell token (build approve() calldata yourself)
mm wallet send-transaction --chain-id <CHAIN> \
  --payload '{"to":"<SELL_TOKEN>","value":"0x0","data":"<approve_calldata>"}' --wait --intent "..."

# Sign the GPv2 order (EIP-712 typed data) -> 0x signature
mm wallet sign-typed-data --chain-id <CHAIN> \
  --payload '{"types":{...},"primaryType":"Order","domain":{...},"message":{...}}' --wait --intent "..."
```

- Wallet address: `mm wallet address --chain-namespace evm`. Readiness: `mm doctor` (`authenticated` + `initialized`).
- **`--wait` is REQUIRED** on result-returning commands — without it you get a `pollingId`, not the signature/hash (then `mm wallet requests watch --polling-id <id>`).
- **`value` in a tx payload must be 0x-hex** (`"0x0"`), not a decimal.
- **`--chain-id` accepts any EIP-155 id** for sign/tx; confirm the chain with `mm chains list`. OP(10) explicit; Unichain(130)/Gnosis(100)/Ink(57073) rely on arbitrary-EIP-155 support — probe at runtime.

## appData (routes the fee to Ophis)

`{"appCode":"ophis","metadata":{"hooks":{},"partnerFee":{"recipient":"0x858f0F5eE954846D47155F5203c04aF1819eCeF8","volumeBps":5},"ophisReferrer":{"code":"<yourcode>"}},"version":"1.4.0"}`

- **`appCode` MUST be `"ophis"`** or the rebate indexer silently drops the order.
- `partnerFee` = CIP-75 VOLUME `{volumeBps, recipient}`; 5 bps default, 1 bp for stable pairs. Recipient is the Ophis Safe (deterministic across chains).
- `ophisReferrer.code` (`/^[a-z0-9_-]{3,64}$/`, optional) = how the integrator earns the rebate.

## Gotchas

1. Sign with `appData` = hash; submit with `appData` = full string + `appDataHash`.
2. On OP/Unichain use the NON-canonical Settlement (signing domain) + VaultRelayer (approve) — canonical addresses fail silently.
3. `appCode` must be exactly `"ophis"`.
4. Enroll the wallet (`GET rebates.ophis.fi/tier/{wallet}`) before the first order.
5. Approve the VaultRelayer (not Settlement) for `sellAmount (+ feeAmount)`.
6. Signed `feeAmount` is `"0"`; a non-zero signed feeAmount is rejected.

## Scaffold status / to validate on a live EAP wallet

- **`mm` JSON output field names are not documented** — the scripts probe `address`/`signature`/`transactionHash` (+ nested `data`/`result`) and fall back to a 0x regex. Confirm the exact keys on first run and pin them.
- **Blockaid / Guard mode:** every `mm` tx runs simulation + Blockaid; an `approve` may be flagged, and in Guard mode gated by wallet policy (`mm wallet policy get/set`). Confirm whether a standard CoW approve/order passes in your mode.
- **eip712 acceptance:** confirm the live orderbook accepts the `mm`-produced EIP-712 signature (signature encoding / v-value). If rejected, check the `mm sign-typed-data` signature format.
- **Chain availability:** `mm chains list` for the current CLI build (esp. Unichain/Gnosis/Ink).
