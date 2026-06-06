# #441 — settle()-only in-process signer policy guard (design)

**Status:** design / scoped. Implementation pending (money-path — TDD + Codex-gated).
**Decision:** drop the AWS KMS path (operator declined recurring cost) AND drop Clef
(adversarial review found it the wrong tool — see "Why not Clef"). Ship the **$0
in-process `PolicyGuarded` `TxSigner` wrapper** instead.

## What this closes (and what it does not)

Threat (threat-model.md): host/driver compromise → submitter-key theft / misuse →
act as the allowlisted solver, **bounded** by on-chain signed limits + the immutable
Settlement/VaultRelayer + the 0.02 ETH/day float cap, until the 2-of-3 Safe evicts.

The guard is a **use** constraint, not a **theft** constraint:
- **Closes:** driver-process RCE *driving the in-process signer* to sign a crafted
  non-settlement tx (token `approve`, raw transfer, drain) → refused. Reduces a
  driver RCE to "can only replay legitimate settlements."
- **Does NOT close:** key *theft* (a thief with the raw key signs off-box, bypassing
  this in-process guard). That residual needs key-out-of-process (KMS — already wired
  as `Account::Kms`, only if/when funded). Clef does not close it either on a single
  box (the keystore passphrase is the new local weak link).

## The allow-set (the part that makes this careful, not trivial)

`crates/driver/src/domain/competition/solution/encoding.rs:230-236` produces **three**
legitimate `to` targets depending on the solution — a naive "only settle()→Settlement"
guard would **reject flashloan/wrapper settlements and brick the solver**:

| Case | `to` | calldata |
|---|---|---|
| normal | `contracts.settlement().address()` | `settle(...)` + appended auction-id bytes |
| flashloan | `contracts.flashloan_router()` (`FlashLoanRouter`) | `flashLoanAndSettle(loans, settlement)` |
| wrapper | the wrapper contract | `simulator::encoding::encode_wrapper_settlement(...)` |
| both | (flashloan+wrapper combined) | combined |

The guard must allow `to ∈ {settlement, flashloan_router?, wrapper(s)?}` with the
matching 4-byte selector for each, and `value == 0` (settlements never send ETH —
`encoding.rs:245`).

**Selectors MUST be resolved from the generated ABIs, not guessed** (`cast sig` on a
hand-written signature already produced a wrong `0x987a2112`):
- `settle` — from `contracts/generated/.../gpv2settlement` (known canonical `0x13d79a0b`, VERIFY against the generated SELECTOR const).
- `flashLoanAndSettle` — from `contracts/generated/contracts-generated/flashloanrouter/src/lib.rs:418,439` (alloy `sol!` exposes a `SELECTOR` const — use it, don't `cast sig`).
- wrapper — resolve from `simulator::encoding::encode_wrapper_settlement` (what selector/`to` does it emit?).

## Design

`crates/driver/src/infra/solver/mod.rs:152-182` — the `Account` enum + its
`impl TxSigner<Signature>` (`sign_transaction` at :169) is the single wrap point and
already sees the full `tx` (`to`, `input`, `value`) before signing. Today there is **no**
such guard anywhere in `crates/driver/src/` (verified).

1. **Pure policy core** (new `policy.rs`, fully unit-tested, no money-path risk):
   `fn check_settlement_tx(to, input: &[u8], value, allow: &SettlementAllowSet) -> Result<(), PolicyViolation>`
   — fail-closed: empty/short calldata, unknown `to`, wrong selector, or non-zero value
   all reject.
2. **Wrapper variant** `Account::PolicyGuarded { inner: Box<Account>, allow: SettlementAllowSet }`
   whose `sign_transaction` runs `check_settlement_tx` on `tx` before delegating to
   `inner`. `sign_hash` (EIP-7702 auth) stays delegated (or is gated separately).
3. **Wiring:** the `allow` set (settlement + flashloan_router + wrapper addresses) comes
   from `contracts` — which `load_account` (`config/file/load.rs:391-414`) does NOT
   currently receive. Thread the three addresses in (from `run.rs` where `contracts` is
   available, wrap each `Account` after construction), OR construct the guard at the
   `run.rs:121-145` registration site. **This is the careful part — keep the guard
   OPT-IN behind config (default off / byte-inert) until validated on Sepolia.**
4. **`run.rs:76-80`** signer-kind log match must gain a `PolicyGuarded` arm (else it
   won't compile).

## TDD plan (write tests first)

- settle()→Settlement with appended auction-id bytes → **allowed**.
- flashLoanAndSettle→router → **allowed**.
- wrapper-settlement→wrapper → **allowed**.
- correct selector but `to` = an arbitrary token (approve target) → **rejected**.
- `to` = Settlement but selector = ERC20 `approve` / `transfer` → **rejected**.
- non-zero `value` → **rejected**.
- empty / < 4-byte calldata → **rejected**.
- (negative) wrapper composes: PolicyGuarded(PrivateKey) signs a real settle; refuses a crafted approve.

## Verification gate (non-negotiable — money path)

- `cargo test -p driver` green; `cargo clippy -p driver` clean.
- Validate on **Sepolia** with a real settlement before any OP enablement (a wrongly-
  rejecting guard breaks settlements — worse than the threat).
- Codex MCP + sharp-edges review BEFORE merge (per the audit-mainnet-contract-wiring rule).
- Ship OPT-IN / default-off; flip on OP only after Sepolia proof.

## Why not Clef (adversarial review verdict)

1. No external-signer transport exists in the alloy fork → Clef is *more* code than the
   already-present `Account::Kms`, not a config swap.
2. Single box → the keystore passphrase is the new local weak link; full root reads
   keystore + passphrase regardless, negating the separate-UID gain.
3. The settle()-only rule belongs in ~100 LoC of in-process Rust at the `TxSigner` wrap
   point we own — not in Clef's niche Otto JS sandbox (a new attack surface).
4. The rule constrains *use of the signing channel*, NOT key theft — a thief bypasses
   Clef entirely. Same true of the in-process wrapper, but the wrapper is free + simpler.

End state, if key-out-of-process is ever funded: **wrapper + `Account::Kms`** (not Clef).
