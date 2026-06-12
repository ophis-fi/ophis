# Fee-recipient rotation runbook

How to change the Ophis protocol fee-recipient address if the Safe that collects
fees is ever compromised (or for a planned treasury move).

The recipient stays a **hardcoded, auditable constant** by design. Rotation is a
reviewed code change plus a redeploy, not an env flip and not a contract upgrade.
See [Why the constant is hardcoded](#why-the-constant-is-hardcoded) for the
rationale.

Canonical address today: `0x858f0F5eE954846D47155F5203c04aF1819eCeF8`
(2-of-3 Safe, CREATE2-deterministic, same address on every CoW chain).

## The one fact that makes this simple

The recipient is **not** a contract parameter. CoW's Settlement contract is
immutable and pays whatever each order's signed `appData` says. The frontend
injects `partnerFee.recipient` into that appData when it builds an order. So:

- Rotation is a **config + redeploy** change. There is no Settlement/Vault
  upgrade, no on-chain migration, no governance transaction.
- **Settled orders already paid the old Safe.** There is no clawback. If the old
  Safe is compromised, moving its existing balance to safety is a separate Safe
  transaction, handled by the signers, out of scope of this code rotation.
- **In-flight orders** signed before the redeploy still carry the old recipient
  (they were signed against the old appData). Only orders signed **after** the
  redeploy use the new recipient.

## When to rotate

- A fee-Safe signer key is leaked or a signer device is compromised.
- The 2-of-3 Safe itself is suspected compromised (rotate to a freshly created
  Safe).
- A planned treasury restructure that moves fee custody.

## Pre-flight

1. Stand up the **new** 2-of-3 Safe (or new EOA, though a Safe is the standard)
   and record its address.
2. Canonicalize it to EIP-55 mixed case before touching any file. Viem's strict
   EIP-55 rejects a bad-case literal and crashes the frontend at init (the
   2026-05-17 incident):

   ```bash
   cast to-check-sum-address 0x<new-address-lowercased>
   ```

   Use that exact mixed-case string everywhere below.

## Rotation surface (every place the address is hardcoded)

The address is declared in separate pnpm workspaces, so a single shared import is
not possible. A cross-workspace CI invariant
(`scripts/check-partner-fee-invariant.sh`) keeps three of them byte-identical and
fails any PR that drifts. **But two production references live outside that
invariant** (rebate-indexer + test fixtures), so always drive the rotation from a
repo-wide grep, not from the invariant's list alone.

Discover the full set:

```bash
grep -rln '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' \
  --include='*.ts' --include='*.tsx' --include='*.sh' . \
  | grep -v node_modules | grep -vE '/(dist|build)/'
```

Known references (update **all** of them):

**Invariant-enforced source of truth (3 files):**
- `apps/frontend/libs/common-const/src/feeRecipient.ts`
- `apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts`
- `packages/sdk/src/partner-fee.ts`

**The invariant's own canonical literal:**
- `scripts/check-partner-fee-invariant.sh` (the `CANONICAL=` line)

**Production references the invariant does NOT cover (do not forget):**
- `apps/rebate-indexer/src/safe/addresses.ts` (`OPHIS_SAFE_ADDRESS`) and any
  `apps/rebate-indexer/src/cron.ts` use of it. The indexer attributes incoming
  fees to this Safe; if it lags, rebate accounting points at the wrong wallet.

**Test fixtures** that assert the address (the grep above lists them, e.g.
`*.test.ts` under `packages/sdk`, `apps/frontend/libs/common-const`,
`apps/rebate-indexer`, `apps/mcp-server`). These must move too or CI fails.

## Procedure

1. Replace the old address with the new EIP-55 string in every file from the
   grep above (production + the invariant literal + tests). Byte-exact, same
   case in all of them.
2. Run the invariant locally, expect exit 0:

   ```bash
   bash scripts/check-partner-fee-invariant.sh
   ```

3. Typecheck + test the touched workspaces:

   ```bash
   pnpm -C apps/rebate-indexer exec tsc --noEmit && pnpm -C apps/rebate-indexer exec vitest run
   pnpm -C packages/sdk test
   # frontend: rely on CI typecheck, or run the common-const + partnerFeeDefault tests
   ```

4. Open a PR. Treat this as an external-API-config change: pre-merge Codex review
   plus all security tools. The `Partner-fee cross-workspace invariant` gate runs
   in CI and blocks merge on any drift.
5. Merge. The **Deploy to Cloudflare Pages** workflow rebuilds swap.ophis.fi;
   from that point new orders inject the new recipient into appData.
6. **Republish `@ophis/sdk`** (bump the patch version) so external integrators
   pick up the new recipient. See `docs/operations/` SDK publish notes / the
   `npm-ophis-token` Keychain entry. Until they upgrade, integrators on the old
   SDK still inject the old recipient.
7. **Redeploy / restart the rebate-indexer** (`ophis-rebates-vm`) so
   `OPHIS_SAFE_ADDRESS` reflects the new Safe and fee attribution follows.

## Verify

- Build a fresh order in the swap UI and inspect its appData: `partnerFee.recipient`
  equals the new address (or decode the appData hash of a just-placed order).
- The `Partner-fee cross-workspace invariant` check is green on the merged PR.
- `grep -rn '<old-address>' --include='*.ts' .` returns only intentional
  historical/archival references (if any), no live production code.
- The rebate-indexer's `OPHIS_SAFE_ADDRESS` is the new Safe and a post-rotation
  fee settles to it.

## Why the constant is hardcoded

Making the recipient env-configurable would let whoever controls the deploy
environment redirect every protocol fee with no code change and no review. The
hardcoded constant plus the cross-workspace CI invariant means:

- The fee destination is **auditable** from source at any commit.
- It **cannot drift silently** (the invariant fails the PR).
- A rotation is always an **on-the-record, reviewed change**, never a hidden env
  edit.

That auditability is itself part of the trust model, so the rotation cost (this
runbook) is the deliberate trade for it.
