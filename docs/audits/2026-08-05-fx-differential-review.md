# F(x) solver differential security review

## Executive summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

**Overall risk:** Medium (new value-transfer integration)

**Recommendation:** Approve the code behind disabled-by-default configuration. Do not enable production Ethereum traffic until a successful live redemption and full Settlement simulation can be recorded; both live markets currently revert with `ErrorUnderCollateral()`.

**Key metrics:**

- Production files analyzed: 8/8
- New external-call paths: 2 (`balanceOf`, `redeem`)
- New execution targets: 1, pinned by configuration (`fxUSD`)
- Security regressions detected: 0
- Findings fixed during review: 3

## What changed

The change adds a native Ethereum solver lane for exact-input SELL orders from fxUSD into a base token returned by the live fxUSD `getMarkets()` registry. It does not add minting, exact-output orders, multi-protocol routing, Ethereum infrastructure, or deployment configuration.

| Component | Change | Risk | Blast radius |
|---|---|---|---|
| `infra/dex/fx/mod.rs` | On-chain authentication, state-override quote, slippage floor, pinned execution calldata | High | One new `Dex` variant |
| `infra/config/dex/fx/*` | Pinned proxy and balance-slot configuration | Medium | F(x) process only |
| CLI/run/metrics/DEX dispatch | New disabled-by-default command | Medium | One match arm each |
| `config/example.fx.toml` | Ethereum example configuration | Low | None until explicitly launched |

## Baseline context and invariants

The existing DEX solver pipeline has these relevant invariants:

1. A swap's call target and allowance spender must not be attacker-selected.
2. The reported output must be the same floor enforced by execution calldata.
3. The Settlement contract must be the execution recipient.
4. Exact-input allowance cannot exceed the order's sell amount.
5. Deterministic route reverts are `NotFound`; RPC/ABI failures remain operational errors.
6. Final solutions flow through the shared strict output-delivery simulation and reference-price guard.

The F(x) lane maintains these invariants by pinning the call target to the configured fxUSD proxy, setting `receiver = Settlement`, reporting the slippage floor used as `minOut`, and using a harmless Settlement self-approval because `redeem` burns its caller directly without `transferFrom`.

## Function micro-analysis

### `Fx::try_new`

**Purpose:** Constructs a lane whose trust boundary is a configured RPC endpoint, Settlement address, fxUSD proxy, and proxy balance slot. It prevents zero-address targets from reaching solution construction.

**Inputs and assumptions:** The provider connects to Ethereum; Settlement is the intended CoW Settlement; fxUSD is the verified proxy; the balance slot is verified at quote time; configuration is operator-controlled.

**Outputs and effects:** Returns an immutable in-process configuration; performs no RPC or state change; establishes non-zero target and recipient invariants.

**Block analysis:** The zero-address rejection occurs before storing configuration because an interaction to address zero or an approval to zero is never meaningful. First principles: configuration that defines a value-transfer target must fail closed before serving requests.

**Dependencies:** Called only by the F(x) CLI arm; its fields are consumed only by `Fx::swap`; invalid configuration terminates process startup.

### `Fx::swap`

**Purpose:** Builds one atomic fxUSD redemption whose quote and execution both use the official proxy entry point. It translates a protocol redemption into the repository's shared `dex::Swap` representation.

**Inputs and assumptions:** The order and slippage are auction inputs; only exact-input SELL is accepted; the configured proxy implements the official interface; `getMarkets()` is authoritative; the node honors state overrides; Settlement will receive the actual output; shared solution simulation remains enabled according to base configuration.

**Outputs and effects:** Performs read-only RPC calls; returns one call to fxUSD; requests an fxUSD allowance no larger than exact input; encodes Settlement as receiver; reports a conservative output excluding optional bonus liquidity.

**Block-by-block analysis:**

- Lines 65-67 reject BUY, mint, and non-fxUSD inputs before external reads. This limits phase-one behavior to a function with native `minOut` protection.
- Lines 68-72 read and enforce the protocol's live market registry. The order's output token cannot choose a call target; it only selects a base token accepted by the pinned proxy.
- Lines 74-77 reject zero input. This prevents meaningless calls and a zero clearing amount.
- Lines 78-101 build a balance-only state override and independently prove `balanceOf(Settlement) == amountIn`. The proof is ordered before `redeem` because a stale proxy layout could otherwise modify unrelated quote state. Five whys: the override is required because Settlement is not pre-funded during quoting; the slot is configurable because proxy layout is upgrade-sensitive; verification is repeated because upgrades can occur after startup; equality is exact because a partial write is insufficient evidence; failure is operational rather than route liquidity.
- Lines 102-109 execute the actual redemption under `eth_call`. A deterministic execution revert becomes route unavailability, while transport/local failures remain RPC errors.
- Lines 111-121 exclude `bonusOut`, clamp slippage, and compute a non-zero floor. Optional reserve bonuses cannot be promised to the user.
- Lines 122-143 encode the same floor into `redeem` and return a pinned target, recipient, input, output, harmless self-approval and gas estimate. First principles: a solver may report only an output that execution itself enforces.

**Cross-function dependencies:** The shared DEX dispatcher is the sole caller; `clamp_slippage_bps` bounds operator slippage; `Swap::into_solution` applies sell-limit, minimum-surplus and output-delivery checks; the Settlement encoder turns the allowance and call into interactions; the external fxUSD proxy calls its registered market and transfers base collateral to Settlement.

**External-call considerations:** The proxy may revert, upgrade, change markets, return malformed data, or produce less output as state changes. Reverts and malformed reads do not produce a swap; upgrades that change balance layout fail the explicit balance proof; market/output changes are bounded by `minOut`; the optional bonus is ignored.

## Adversarial analysis

**Attacker model:** An order creator controls sell amount and desired output token but does not control solver configuration, fxUSD proxy target, Settlement receiver, or state override location.

**Attempted vectors:**

1. Select a malicious output token: rejected unless returned by the pinned proxy's current market registry.
2. Inflate output through bonus liquidity: bonus is excluded from the reported clearing amount.
3. Exploit a stale balance slot to alter quote state: the independent overridden `balanceOf` equality check fails before redemption.
4. Trigger a large redemption revert to stall partial fills: deterministic execution reverts map to `NotFound`, enabling smaller retry; transport failures do not poison fill discovery.
5. Redirect collateral: recipient is always configured Settlement in both quote and calldata.
6. Drain a Settlement buffer through allowance: `redeem` requires no allowance, so the required shared swap field self-approves Settlement and grants no external contract spending authority.

No exploitable path was found in the reviewed scope.

## Findings fixed during review

### Stale storage-slot quote divergence

The initial implementation trusted slot `151` without proving it controlled `balanceOf(Settlement)`. A future proxy layout change could make the quote override touch unrelated state. Fixed by verifying the overridden balance through the proxy before every redemption quote.

### Quote revert classification

The initial implementation classified every quote failure as route unavailability. That would treat RPC outages like insufficient liquidity and incorrectly drive partial-fill backoff. Fixed by adopting the repository's execution-revert classifier: only JSON-RPC execution reverts become `NotFound`.

### Unnecessary proxy allowance

The initial swap shape approved the upgradeable fxUSD proxy even though `redeem` burns `_msgSender()` directly. Because redemption does not consume ERC-20 allowance, that approval could persist and become dangerous after a malicious proxy upgrade. Fixed by using Settlement as the required allowance field's spender, producing only a harmless self-approval.

## Test coverage

Covered directly:

- Solidity mapping-key derivation
- Overflow-safe slippage floor
- Execution-revert classification
- Transport-failure classification
- Official `redeem` ABI selector
- Backend compilation and complete solver unit suite
- Live Ethereum proof that slot `151` overrides Settlement's fxUSD balance

Not yet coverable:

- Successful live redemption: both current markets revert with `ErrorUnderCollateral()`.
- Full production Settlement simulation: no Ethereum F(x) deployment configuration has been added.

These gaps block production enablement but do not block merging disabled code.

## Historical and blast-radius analysis

The new lane follows the hardened Pons direct-liquidity pattern and the shared output guard added in the solver security-hardening history. No security validation was removed. Dispatch blast radius is one new enum arm through the existing single-order DEX solver; all existing lanes retain their prior behavior.

## Recommendations

### Before production

- Record a successful mainnet `redeem` quote after F(x) exits under-collateral mode.
- Run the resulting swap through the full Settlement output-delivery simulator.
- Pin an Ethereum runtime configuration with strict market output simulation set to `all`.
- Re-verify proxy implementation, market list and balance slot at rollout time.
- Add monitoring for `InvalidBalanceSlot`, redemption reverts and proxy implementation changes.

### Future scope

- Treat minting as a separate change because it needs base-token balance and allowance overrides.
- Treat exact-output redemption as a separate change with bounded inversion and partial-liquidity tests.

## Methodology

**Strategy:** Surgical, high-risk differential review.

Reviewed all changed production files, the complete new swap function, its configuration and dispatch callers, the shared allowance/output-guard pipeline, the official verified fxUSD redemption implementation, relevant git history, and live Ethereum contract behavior. The review used baseline invariant reconstruction, line-by-line external-call analysis, blast-radius tracing, execution-revert testing, and adversarial order-input modeling.

**Confidence:** High for the disabled solver code and exact-input redemption construction; medium for production readiness because a successful live redemption was unavailable during review.

The full solver test suite and driver compilation pass. Clippy with `-D warnings` cannot complete because pre-existing warnings in `poison-recovery` (`explicit_auto_deref`) and `app-data` (`mixed_case_hex_literals`) are promoted to errors before the F(x) crate analysis completes; neither file is changed by this integration.

## Independent Codex follow-up

The first Codex 5.6 Sol pass rejected the implementation and identified three issues, all fixed before merge:

- Ethereum driver authorization now accepts only the exact fxUSD `redeem(address,uint256,address,uint256)` calldata shape. It binds the receiver to Settlement and binds calldata assets and amounts to the interaction inputs, outputs, and self-allowance. The fxUSD proxy is deliberately excluded from the generic address-only router allowlist, preventing arbitrary ERC-20 selectors such as `transfer`.
- The balance-slot proof first reads the live Settlement balance and overrides it with a different sentinel. This proves the configured slot actually controls `balanceOf` before the requested order amount is used for the redemption quote.
- The Odos-removal replay's pathviz fixture now uses one consistent neutral solver node ID.

Regression coverage includes malicious-selector and attacker-receiver rejection in the driver, the complete pathviz suite, and the F(x) adapter unit tests.

The second Codex pass found that selector scoping alone was insufficient because the solver-declared `minOut` metadata was not authenticated against the actual trade. The final driver path derives the required buy amount from the single fulfillment's executed sell amount and uniform clearing prices using Settlement's ceiling-division rule, then requires calldata `minOut` to equal that amount. The specialized path also applies the global allowance cap, and the F(x) config loader forcibly disables buffer internalization so redemption can never be skipped in favor of Settlement inventory.

The third pass refined that binding for fee-bearing limit orders and input-buffer safety: calldata `minOut` may be stricter than the credited fulfillment output, while `amountIn` must exactly equal `executed_amount + fee`. The DTO gate also requires exactly one fulfillment and exactly one fxUSD custom interaction, preventing repeated redemptions from consuming pre-existing Settlement fxUSD inventory.
