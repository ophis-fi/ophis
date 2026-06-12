# Fee-recipient rotation runbook

How to change the Ophis protocol fee-recipient address if the Safe that collects
fees is ever compromised (or for a planned treasury move).

The recipient stays a **hardcoded, auditable constant** by design. Rotation is a
reviewed code change plus a coordinated redeploy across the frontend, the SDK,
**the OP backend allowlist**, and the settlement-sweep / monitoring config, not
an env flip and not a contract upgrade. See
[Why the constant is hardcoded](#why-the-constant-is-hardcoded) for the rationale.

Canonical address today: `0x858f0F5eE954846D47155F5203c04aF1819eCeF8`
(Safe v1.4.1, 2-of-3, CREATE2-deterministic, same address on Optimism + Gnosis +
Ethereum).

> This is a fork-aware procedure. Read [The model](#the-model-two-enforcement-paths)
> first: the OP backend **rejects** orders whose partner-fee recipient is not in
> its allowlist, and OP fees sit in the Settlement contract until swept. A
> frontend-only change will break fee collection, not silently misroute it.

## The model (two enforcement paths)

1. **Recipient injection (frontend / SDK).** CoW's Settlement is immutable and
   pays whatever each order's signed `appData` says. The frontend injects
   `partnerFee.recipient` into appData at order-build time. So the *destination*
   is a config value, not a contract parameter.
2. **Recipient enforcement (OP backend).** The Ophis OP fork does **not** accept
   an arbitrary recipient. `PARTNER_FEE_RECIPIENT_ALLOWLIST`
   (`apps/backend/crates/app-data/src/app_data.rs`) is checked both at app-data
   validation (`app_data.rs`, line ~335) and in the autopilot fee domain
   (`apps/backend/crates/autopilot/src/domain/fee/mod.rs`, line ~253). An order
   carrying a non-allowlisted recipient is **rejected / its partner-fee policy
   dropped**, not paid to the new address.
3. **Custody (OP sweep).** On OP, CIP-75 fees accumulate in the Settlement
   contract (`0x310784c7…`) and are moved to the Safe only by a sweep
   (`infra/optimism-mainnet/scripts/sweep-to-safe.sh` /
   `contracts/script/SweepSettlementBuffer.s.sol`). "Settled" does not mean
   "already in the Safe."

Consequences for rotation:

- You must add the new recipient to the **backend allowlist and redeploy the OP
  backend before** (or together with) the frontend, or new swap.ophis.fi orders
  get rejected.
- The replacement must be controllable at the **same address on every fee
  chain** (the constant is one address used on all of them).
- **Sweep the Settlement buffer** as part of rotation; do not assume settled
  fees are already in the old Safe.
- The recipient is also emitted by the **public `@ophis/sdk`**, so external
  integrators keep emitting the old address until they upgrade. The old recipient
  stays allowlisted through a migration window before it is removed (a planned
  rotation waits for the cutoff; a compromise forces it early).

## When to rotate

- A fee-Safe signer key is leaked or a signer device is compromised.
- The 2-of-3 Safe itself is suspected compromised (rotate to a freshly created
  Safe).
- A planned treasury restructure that moves fee custody.

## Pre-flight

1. **Same address on every fee-emitting chain.** The app/SDK/backend use one
   recipient on every chain where the partner-fee gate fires, not just OP. Do
   **not** assume three chains: **enumerate the current set** from
   `OPHIS_FEE_CHAIN_IDS` in `packages/sdk/src/partner-fee.ts` (the frontend gate
   `shouldEmitOphisPartnerFee` mirrors it):

   ```bash
   grep -A5 'FEE_CHAIN_IDS = \[' packages/sdk/src/partner-fee.ts
   ```

   Today that is the Ophis-operated chains `10, 4326, 999` (Optimism live;
   MegaETH `4326` + HyperEVM `999` paused) plus the CoW-hosted mainnets
   `1, 56, 100, 137, 8453, 9745, 42161, 43114, 57073, 59144` (and Sepolia
   `11155111`, testnet). The replacement must be controllable at the **same
   address on every chain where a fee actually settles**: a CREATE2-deterministic
   Safe with a deployment plan proving the address resolves and is owned on each
   chain, or an EOA you control everywhere. Do **not** reuse a single-chain Safe
   address globally, fees on the other chains would go to an address with no Safe
   deployed. (The current Safe is verified 2-of-3 on OP + Gnosis + Ethereum; any
   other chain in the set that is live must be verified the same way.)
2. **EIP-55 checksum** the new address before touching any file (strict EIP-55
   crashes the frontend at init, the 2026-05-17 incident):

   ```bash
   cast to-check-sum-address 0x<new-address-lowercased>
   ```

3. **Raw-byte form for Rust.** `PARTNER_FEE_RECIPIENT_ALLOWLIST` stores the
   address as 20 raw bytes (`Address::new([0x85, 0x8f, ...])`), not a hex string.
   Pre-compute the byte array:

   ```bash
   python3 -c "a='<new-address-no-0x>'; print(', '.join('0x'+a[i:i+2] for i in range(0,40,2)))"
   ```

## Rotation surface

The address is declared across several pnpm/cargo workspaces and infra, so a
single shared import is impossible. A cross-workspace CI invariant
(`scripts/check-partner-fee-invariant.sh`) keeps three frontend/SDK files
byte-identical, **but most of the surface is outside that invariant.** Always
drive the rotation from a **repo-wide** search, not the invariant's list:

```bash
grep -rln '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' . \
  | grep -v node_modules | grep -vE '/(dist|build|target)/'
```

Known production references (update **all**; the byte-array one is the backend):

**Recipient enforcement (OP backend), do this FIRST:**
- `apps/backend/crates/app-data/src/app_data.rs`: `PARTNER_FEE_RECIPIENT_ALLOWLIST`
  (raw-byte `Address::new([...])`).

**Recipient injection (frontend / SDK), invariant-enforced trio + the check:**
- `apps/frontend/libs/common-const/src/feeRecipient.ts`
- `apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts`
- `packages/sdk/src/partner-fee.ts`
- `scripts/check-partner-fee-invariant.sh` (the `CANONICAL=` literal)

**Custody / monitoring (sweep + drift), or fees keep flowing to the old Safe:**
- `contracts/script/SweepSettlementBuffer.s.sol` (`DEFAULT_SAFE`)
- `infra/optimism-mainnet/scripts/sweep-to-safe.sh`,
  `infra/optimism-mainnet/scripts/check-settlement-buffer.sh`,
  `infra/optimism-mainnet/scripts/verify-e2e-swap.sh`,
  `infra/optimism-mainnet/README.md`
- `infra/shared/cron/safe-drift-check.sh.tmpl` (the weekly Safe drift monitor; it
  alerts on drift from this Safe, so it must track the new one)

**Rebate accounting:**
- `apps/rebate-indexer/src/safe/addresses.ts` (`OPHIS_SAFE_ADDRESS`),
  `apps/rebate-indexer/src/cron.ts`, `apps/rebate-indexer/RUNBOOK.md`

**Deployed env (read at runtime, not just source):**
- Any live `.env` that sets `OPHIS_PARTNER_FEE_RECIPIENT`
  (`infra/megaeth/.env.example` is the template; update the real `.env` on each
  backend host).

**User-facing docs (accuracy):**
- `apps/docs-ophis/docs/audits.md`, `docs/operations/e2e-swap-verification.md`.

**Leave (dated historical records):** `docs/audits/2026-05-*`,
`docs/development/phase-*-validation.md`, `docs/development/plans/2026-05-*`, and
the already-applied migration comment in
`apps/rebate-indexer/migrations/0005_affiliate.sql` (do not rewrite an applied
migration; it documents the Safe at seed time).

## Procedure (ordered to avoid rejected orders or misrouted fees)

1. **Sweep first.** Run the OP settlement-buffer sweep so accrued fees land in
   the **currently-controlled** Safe before anything changes
   (`infra/optimism-mainnet/scripts/sweep-to-safe.sh`). If the old Safe is
   compromised, sweep with `SAFE=<new-address>` instead so the buffer goes
   straight to the replacement.
2. **One reviewed change adds (does not yet replace) the recipient.** In a single
   PR, update every file from the grep above: **add** the new address to
   `PARTNER_FEE_RECIPIENT_ALLOWLIST` (raw bytes) **while keeping the old entry**
   (so in-flight and not-yet-migrated orders stay accepted), and flip the
   injection / custody / accounting / env / docs (frontend/SDK trio, invariant
   `CANONICAL`, sweep config, drift monitor, rebate, live `.env`, docs).
   Byte-exact EIP-55 in the TS/JSON/sh/sol files; the raw-byte form in Rust.
   **Do not hot-patch the production allowlist out of band.** The allowlist is the
   enforcement boundary, so widening it must go through review like any other
   recipient change, that auditability is the whole point of the constant.
3. **Local gates:**

   ```bash
   bash scripts/check-partner-fee-invariant.sh            # exit 0
   cargo test -p app-data -p autopilot                    # backend allowlist tests
   pnpm -C apps/rebate-indexer exec tsc --noEmit && pnpm -C apps/rebate-indexer exec vitest run
   pnpm -C packages/sdk test
   ```

4. **PR** with pre-merge Codex + all security tools (treat as an external-API /
   on-chain-config change). The `Partner-fee cross-workspace invariant` gate runs
   in CI.
5. **Merge, then deploy backend-first.** The reviewed OP backend (allowlist now
   holds **both** old + new) → frontend (swap.ophis.fi) → republish `@ophis/sdk`
   (bump patch; `npm-ophis-token` Keychain) → redeploy/restart the rebate-indexer
   (`ophis-rebates-vm`) → update the deployed sweep config + the cron drift
   monitor. Backend-first means a new-recipient order is accepted the instant the
   frontend starts emitting it, while the old recipient keeps working throughout.
6. **Integrator migration window (planned rotations, do not skip).** `@ophis/sdk`
   is a **public npm package**; external agents build their own orders with
   `buildOphisAppDataPartnerFee` and keep emitting the **old** recipient until
   they upgrade. Announce the new recipient and a deprecation cutoff for the old
   one, and **monitor for orders still carrying the old recipient** (appData
   recipient in the orderbook / autopilot logs). Keep the old recipient
   allowlisted for the whole window.
7. **Retire the old recipient (second reviewed change).** Open a second PR that
   **removes** the old address from `PARTNER_FEE_RECIPIENT_ALLOWLIST`, merge it,
   and redeploy the OP backend so only the new Safe is accepted. Timing depends on
   the trigger:
   - **Planned rotation:** wait until the migration cutoff has passed and
     old-recipient orders have stopped. Removing it earlier rejects not-yet-migrated
     SDK integrators.
   - **Compromise:** the old Safe is hostile, so every order still paying it is a
     loss. Retire the old recipient **as soon as the new path is live** (step 5),
     accepting that in-flight and un-migrated orders are rejected until clients
     upgrade. Communicate the forced cutoff urgently.
8. **Secure the old Safe.** If it was compromised, moving its remaining balance is
   a separate Safe transaction handled by the signers, out of scope of this code
   rotation.

## Verify

- A fresh swap.ophis.fi order is **accepted** (not rejected) and its appData
  `partnerFee.recipient` equals the new address. (A rejected order means the
  backend allowlist step was missed.)
- `bash scripts/check-partner-fee-invariant.sh` is green; the CI invariant passed.
- `grep -rn '<old-address>' . | grep -vE '/(node_modules|dist|build|target)/'`
  returns only the intentional dated-historical references.
- The sweep targets the new Safe, the drift monitor watches the new Safe, and the
  rebate-indexer's `OPHIS_SAFE_ADDRESS` is the new Safe.
- A post-rotation fee sweeps to the new Safe on every fee chain.

## Why the constant is hardcoded

Making the recipient env-configurable would let whoever controls the deploy
environment redirect every protocol fee with no code change and no review. The
hardcoded constant, the cross-workspace CI invariant, and the on-chain backend
allowlist together mean:

- The fee destination is **auditable** from source at any commit.
- It **cannot drift silently** (the invariant fails the PR; the backend rejects
  an unlisted recipient).
- A rotation is always an **on-the-record, reviewed change**, never a hidden env
  edit.

That auditability is itself part of the trust model, so the rotation cost (this
runbook) is the deliberate trade for it.
