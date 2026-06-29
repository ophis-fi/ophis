# Fill-In After Deploy — Unichain Mainnet (chain 130)

This file tracks every placeholder that must be replaced with real values after
the Phase-1 Ledger ceremony deploys the sovereign contracts on Unichain.

Source of truth for all addresses: `contracts/networks.json` (entry for chainId 130),
populated by `deploy-mainnet-all.sh` at ceremony time. The three `cast --create`
contracts (Balances / Signatures / HooksTrampoline) are NOT in networks.json
(hardhat-deploy didn't deploy them); their addresses live in `.env` as
`OPHIS_BALANCES_UNICHAIN` / `OPHIS_SIGNATURES_UNICHAIN` / `OPHIS_HOOKS_TRAMPOLINE_UNICHAIN`.

---

## DEPLOYED 2026-06-29 (Ledger ceremony complete; governance → 2-of-3 Safe)

| Contract | Address | Source |
|---|---|---|
| AllowListAuthentication (proxy) | `0x1002E12f2e7f848b20fe572F92133E467a5D010C` | networks.json |
| AllowListAuthentication (impl)  | `0x2Ddcc99cD0F2Ba3De0cc37B28ec89921814bBe35` | networks.json |
| GPv2Settlement                  | `0x108A678716e5E1776036eF044CAB7064226F714E` | networks.json |
| GPv2VaultRelayer                | `0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb` | networks.json |
| Balances (artifact)             | `0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A` | .env |
| Signatures (artifact)           | `0x5f315A204E7971fC29a66fef3a5773f6B0202fac` | .env |
| HooksTrampoline (artifact)      | `0x2FbB1e41fF4f9b707E4428EEC7F5AFAaC5D60810` | .env |
| Submitter EOA (WS10)            | `0x7A956C269a12f1B897367663b536EB5dd29f3fBb` | allowlisted ✓ |

Governance: `owner()` == `manager()` == protocol Safe `0xe049a64546fb8564CC4c7D64A0A1BAe00Aa801cF`
(2-of-3 on chain 130). `isSolver(submitter)` == true. Verified on the public RPC
post-ceremony. Direct-to-Safe (no Timelock yet) — see VALIDATION.md GOVERNANCE BLOCKER.

All `configs/*.toml.tmpl` placeholders were filled with these (checksummed) on
2026-06-29; `grep -rn __FILL_AFTER_DEPLOY configs/` is clean.

---

## Contract Address Placeholders

Replace every occurrence of the placeholder strings below with the real deployed addresses.

### `__FILL_AFTER_DEPLOY_SETTLEMENT__`
The `GPv2Settlement` contract address on Unichain.
**Files:**
- `configs/driver.toml.tmpl` — `[contracts] gp-v2-settlement`
- `configs/autopilot.toml.tmpl` — `[contracts] settlement`
- `configs/orderbook.toml.tmpl` — `[shared.contracts] settlement`
- `configs/okx.toml.tmpl` — top-level `settlement`
- `configs/kyberswap.toml.tmpl` — top-level `settlement`
- `configs/velora.toml.tmpl` — top-level `settlement` (when un-commented)

### `__FILL_AFTER_DEPLOY_BALANCES__`
The `GPv2VaultRelayer` (balances) contract address on Unichain.
**Files:**
- `configs/driver.toml.tmpl` — `[contracts] balances`
- `configs/autopilot.toml.tmpl` — `[contracts] balances`
- `configs/orderbook.toml.tmpl` — `[shared.contracts] balances`

### `__FILL_AFTER_DEPLOY_SIGNATURES__`
The `GPv2SignatureVerifier` (signatures) contract address on Unichain.
**Files:**
- `configs/driver.toml.tmpl` — `[contracts] signatures`
- `configs/autopilot.toml.tmpl` — `[contracts] signatures`
- `configs/orderbook.toml.tmpl` — `[shared.contracts] signatures`

### `__FILL_AFTER_DEPLOY_HOOKS__`
The `GPv2HooksTrampoline` (hooks) contract address on Unichain.
**Files:**
- `configs/autopilot.toml.tmpl` — `[contracts] hooks`
- `configs/orderbook.toml.tmpl` — `[shared.contracts] hooks`

### `__FILL_AFTER_DEPLOY_ETHFLOW__`
The `CoWSwapEthFlow` contract address on Unichain (enables native ETH sells).
**Files:**
- `configs/autopilot.toml.tmpl` — `[ethflow] contracts` (currently commented out)

Also update `OPHIS_ETHFLOW_OVERRIDES` in
`apps/frontend/libs/common-const/src/common.ts`:
- Change `130: '0x0000000000000000000000000000000000000000'` to the deployed EthFlow address.

---

## Frontend Merge Ordering

### SAFE to merge anytime (no Unichain stack required)

**`apps/frontend/libs/common-const/src/feeRecipient.ts`**
Adds `[SupportedChainId.BASE]: OPHIS_PARTNER_FEE_RECIPIENT` to
`DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK`. Without this entry, Unichain fees
leak to CoW's default placeholder recipient. This is a fee-leak fix that is
safe regardless of whether the sovereign Unichain stack is live.

**`apps/frontend/libs/common-const/src/common.ts`**
Adds `130: '0x0000000000000000000000000000000000000000'` to `OPHIS_ETHFLOW_OVERRIDES`
(sentinel zero = EthFlow disabled on Unichain until deployed). Safe to merge anytime.

### DO NOT merge until Unichain stack is LIVE and shadow-validated (Phase 5)

**`apps/frontend/apps/cowswap-frontend/src/cowSdk.ts`**
Adds `[SupportedChainId.BASE]: OPHIS_BASE_ORDERBOOK_URL` routing Unichain orders
to `https://unichain-mainnet.ophis.fi`. If merged before the Unichain stack is live,
the frontend routes Unichain traffic to a dead endpoint — existing Unichain orders
stop working entirely.

**`apps/frontend/apps/explorer/src/cowSdk.ts`**
Same risk — routes the explorer's Unichain API calls to the sovereign orderbook.
Must NOT ship before Phase 5 shadow-validation passes.

---

## Vault Relayer Allowlist

After deploying Settlement, the **Unichain** driver-submitter EOA (a NEW per-chain
EOA created in WS10, NOT the OP submitter `0x92B9…`) must be added to the
`AllowListAuthentication` contract on Unichain (same ceremony step as OP):
```
cast send <ALLOWLIST_AUTH_ADDRESS> "addSolver(address)" <UNICHAIN_SUBMITTER_EOA> --ledger
```
That same EOA address fills `__FILL_AFTER_DEPLOY_SUBMITTER__` in
`configs/autopilot.toml.tmpl` (the `[[drivers]]` `address` fields), and its private
key goes in `.env` as `OPHIS_DRIVER_SUBMITTER_KEY` (used by driver.toml). The
autopilot `address` and the driver key MUST be the same EOA, or solver
authentication fails.

The `AllowListAuthentication` proxy address is also a fill-in placeholder
(`__FILL_AFTER_DEPLOY_ALLOWLIST_AUTHENTICATION_PROXY__`) if you add it to
the monitoring scripts in `scripts/`. Update those once the address is known.

---

## Checklist

- [x] Deploy all contracts on Unichain via Ledger ceremony (`deploy-mainnet-all.sh`) — 2026-06-29
- [x] Populate `contracts/networks.json` chainId 130 entry — done by hardhat-deploy (patch-protected at `deploy/networks-json-130.patch`)
- [x] Replace all `__FILL_AFTER_DEPLOY_*__` in `configs/*.toml.tmpl` (WS3 contracts: SETTLEMENT / BALANCES / SIGNATURES / HOOKS; WS10: SUBMITTER). ETHFLOW deferred (sentinel renamed to `<ethflow-addr-after-deploy>`, commented). `grep -rn __FILL_AFTER_DEPLOY configs/` clean — 2026-06-29
- [x] Add submitter EOA to AllowListAuthentication on Unichain — `isSolver(0x7A956C26…)` == true, verified on-chain
- [ ] Run `./render-configs.sh` to render updated templates (Gate 3 — on the VM; submitter PK at `/opt/ophis-submitter/submitter.json`)
- [ ] Run `./compose-up.sh` to start the stack (Gate 3 — on the VM)
- [ ] Shadow-validate: send a test order, verify settlement in explorer
- [ ] Merge `feeRecipient.ts` fix (safe anytime — do it now)
- [ ] Merge `common.ts` EthFlow sentinel (safe anytime)
- [ ] After Phase 5 passes: merge both `cowSdk.ts` Unichain flips
- [ ] After EthFlow deployed: update `OPHIS_ETHFLOW_OVERRIDES[130]` + `autopilot.toml.tmpl`
