# Entry Point Map

> Ophis Vault Policy Module | 7 entry points | 1 permissionless | 3 role-gated | 3 admin-only | + 2 constructors

Scope: Ophis-authored contracts only (`src/contracts/vault/*`, `src/contracts/AllowListGuardian.sol`). Vendored CoW GPv2 entry points (`GPv2Settlement.settle`, `GPv2Signing.setPreSignature`, `GPv2AllowListAuthentication.*`) are trusted third-party and excluded.

---

## Protocol Flow Paths

### Setup (Deployer → Safe Owners)

`Factory.deploy(cfg)` → `new OphisVaultPolicyModule(cfg)`  ◄── curator must not be a Safe owner or enabled module
                                    │
                                    └─→ `[owners] safe.enableModule(module)`  ◄── off-chain Safe tx, not a module entry point

### Curator Flow (steady state)

`[setup above]` → `module.rebalance(order, minBuyOverride)`  ◄── order built off-chain by safe-swap; feeds fresh; sequencer up
                            │
                            ├─→ `module.cancel(orderUid)`  ◄── uid must be in `moduleOrderSellToken`
                            │
                            └─→ [solver fills via settlement]  ◄── no module involvement; proceeds land on the Safe

Supersession is implicit: a second `rebalance` on the same sell token revokes the predecessor's presignature inside the same call.

### Chain Governance (orthogonal to the vault module)

`[deploy + install guardian as authenticator.manager()]`
   ├─→ `guardian.addSolver()`     ◄── timelock, >= 24h announced delay
   ├─→ `guardian.setManager()`    ◄── timelock
   ├─→ `guardian.setGuardian()`   ◄── timelock
   └─→ `guardian.removeSolver()`  ◄── guardian Safe, instant (capability-reducing only)

---

## Permissionless

### `OphisVaultPolicyModuleFactory.deploy()`

| Aspect | Detail |
|--------|--------|
| Visibility | `external` |
| Caller | Anyone (deployment convenience; the deployed module's authority derives entirely from `cfg`) |
| Parameters | `cfg` (user-controlled) — full `ModuleConfig`: safe, settlement, curator, appDataHash, maxSlippageBps, maxTtl, dailyUsdTurnoverCap, sequencerUptimeFeed, sequencerGracePeriod, tokens[] |
| Call chain | `→ ISafe.getOwners() → ISafe.isModuleEnabled() → new OphisVaultPolicyModule() → IGPv2Settlement.vaultRelayer() → IGPv2Settlement.domainSeparator() → IERC20Metadata.decimals() → IAggregatorV3.decimals() → OphisChainlinkFloor.read18() → IAggregatorV3.latestRoundData()` |
| State modified | None in the factory (stateless); the new module's immutables and `tokenPolicy` are written in its constructor |
| Value flow | None |
| Reentrancy guard | no (no state, no value) |

A module deployed by an arbitrary caller has no power over any Safe until that Safe's owners call `enableModule`. The factory's checks are deploy-time hygiene, not authorization.

---

## Role-Gated

### `curator` (immutable, direct-caller EOA / MPC / multisig)

#### `OphisVaultPolicyModule.rebalance()`

| Aspect | Detail |
|--------|--------|
| Visibility | `external`, `nonReentrant` |
| Caller | Curator key (checked at `:328`, `msg.sender != curator` → `NotCurator`) |
| Parameters | `order` (user-controlled — full `GPv2Order.Data`, every field re-validated on-chain), `minBuyOverride` (user-controlled — can only tighten the floor) |
| Call chain | `→ OphisVaultPolicyModule._enforcePolicy() → _checkSequencer() → IAggregatorV3.latestRoundData() → OphisChainlinkFloor.read18() → OphisChainlinkFloor.floorBuyAmount()` then `→ _recordTurnover() → _deriveUid() → GPv2Order.hash() → GPv2Order.packOrderUidParams()` then `→ _exec() → ISafe.execTransactionFromModuleReturnData() → IGPv2Settlement.setPreSignature(superseded, false)` and `→ _approveAndPresign() → IERC20.allowance() → _safeApprove() → ISafe.execTransactionFromModuleReturnData() → IERC20.approve(relayer, exact)` → `IGPv2Settlement.setPreSignature(uid, true)` |
| State modified | `moduleOrderSellToken[key]` (set), `moduleOrderSellToken[supersededKey]` (deleted if superseding), `liveAllowanceUid[sellToken]`, `liveAllowanceOrderUid[sellToken]`, `turnoverSpentUsd`, `lastTurnoverTs` |
| Value flow | None directly. Sets an exact ERC20 allowance from the Safe to the vault relayer, enabling a later solver-initiated pull of `sellAmount` out of the Safe and a matching delivery of `>= buyAmount` back to it. |
| Reentrancy guard | yes (`nonReentrant`) |

Effects precede interactions: all four mapping writes land at `:347-350` before the first `_exec` at `:358`.

#### `OphisVaultPolicyModule.cancel()`

| Aspect | Detail |
|--------|--------|
| Visibility | `external`, `nonReentrant` |
| Caller | Curator key (checked at `:390`) |
| Parameters | `orderUid` (user-controlled, but must hash to a key present in `moduleOrderSellToken`) |
| Call chain | `→ _exec() → ISafe.execTransactionFromModuleReturnData() → IGPv2Settlement.setPreSignature(uid, false)` then conditionally `→ IERC20.allowance() → _safeApprove() → ISafe.execTransactionFromModuleReturnData() → IERC20.approve(relayer, 0)` |
| State modified | `moduleOrderSellToken[key]` (deleted), and — only when `liveAllowanceUid[sellToken] == key` — `liveAllowanceUid[sellToken]` and `liveAllowanceOrderUid[sellToken]` (deleted) |
| Value flow | None. Strictly risk-reducing: removes a presignature and may shrink an allowance to zero. |
| Reentrancy guard | yes (`nonReentrant`) |

### `guardian` (rotatable Safe, chain governance)

#### `AllowListGuardian.removeSolver()`

| Aspect | Detail |
|--------|--------|
| Visibility | `external`, `onlyGuardian` |
| Caller | Protocol Safe |
| Parameters | `solver` (user-controlled) |
| Call chain | `→ GPv2AllowListAuthentication.removeSolver()` |
| State modified | None locally; clears the solver bit in the authenticator's storage |
| Value flow | None |
| Reentrancy guard | no |

Instant by design: defensive eviction of a compromised submitter must never be delayed.

---

## Admin-Only

Gated by `onlyTimelock` — an OpenZeppelin `TimelockController` with a `>= 24h` minimum delay. Every capability-adding operation is announced on-chain and cannot take effect inside the delay window.

| Contract | Function | Parameters | State Modified |
|----------|----------|------------|----------------|
| `AllowListGuardian` | `addSolver(address solver)` | `solver` (user-controlled) | None locally; sets the solver bit in the authenticator |
| `AllowListGuardian` | `setManager(address newManager)` | `newManager` (user-controlled, non-zero enforced) | None locally; hands off the authenticator's `manager()` role |
| `AllowListGuardian` | `setGuardian(address newGuardian)` | `newGuardian` (user-controlled, non-zero enforced) | `guardian` |

`AllowListGuardian` has no escape hatch: if the timelock is ever broken, the slow path freezes permanently and only the capability-reducing `removeSolver` keeps working. This is a deliberate fail-safe, documented at `AllowListGuardian.sol:39-49`.

---

## Initialization

Neither contract is upgradeable or proxy-backed; both use plain constructors with no `initialize()` function and therefore no initialization front-running window.

| Contract | Constructor | Key one-time effects |
|----------|-------------|----------------------|
| `OphisVaultPolicyModule` | `constructor(ModuleConfig memory cfg)` | Writes 11 immutables (`:265-280`), seeds `lastTurnoverTs`, populates `tokenPolicy` for every configured token (`:283-309`), reads `vaultRelayer()` + `domainSeparator()` from the settlement rather than accepting them as params, rejects a privileged curator (`:263`), and fail-closed liveness-probes every feed (`:301`) |
| `AllowListGuardian` | `constructor(address authenticator_, address timelock_, address guardian_)` | Writes `authenticator` and `timelock` immutables, sets the initial `guardian`, emits `GuardianChanged` |
