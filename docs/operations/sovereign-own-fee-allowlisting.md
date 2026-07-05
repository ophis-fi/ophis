# Sovereign own-fee allowlisting (internal runbook)

How Ophis adds an integrator's own-fee recipient to the partner-fee allowlist on
the sovereign chains (Optimism 10, Unichain 130), so their stacked `partnerFee`
entry is not rejected at ingress.

> IMPORTANT: allowlisting is only the INGRESS gate. It lets the order settle and
> the fee be charged; on its own it does NOT pay the fee back to the partner. On
> the sovereign chains the fee policy drops any non-allowlisted recipient
> (`Policy::Volume { factor }` in
> `apps/backend/crates/autopilot/src/domain/fee/policy.rs`) and the settlement
> buffer is swept to a SINGLE Safe (`SweepSettlementBuffer.s.sol` /
> `infra/*/scripts/sweep-to-safe.sh`, the Ophis Safe). Per-recipient payout back
> OUT of that Safe is now BUILT (`apps/rebate-indexer/src/ownFee/`): the indexer
> meters each allowlisted recipient's charged own-fee per settled trade and pays
> it MONTHLY in WETH from the sovereign chain's Ophis Safe (a 2-of-3 Safe
> MultiSend), taking 0% of it. So onboarding a recipient is now TWO ops steps:
> (1) allowlist it in the backend (Step 1 below), then (2) enable + fund the
> own-fee payout (Step 2 below). Both are gated: the payout also needs
> `OWN_FEE_PAYOUT_ENABLED=true` (default OFF), the recipient in
> `SOVEREIGN_OWN_FEE_RECIPIENTS`, and a funded Safe. Until ALL of those hold for a
> recipient, its charged own-fee stays in the Ophis Safe. Do NOT tell a partner
> they receive their own fee just because they are allowlisted. Onboard a third
> party only when there is a payout arrangement, or for an Ophis-controlled
> recipient.

Background: the self-hosted backend enforces `PARTNER_FEE_RECIPIENT_ALLOWLIST`
in `apps/backend/crates/app-data/src/app_data.rs`. `validate_partner_fees`
rejects the WHOLE order if any `partnerFee` recipient is not in that list, and by
default only the Ophis Safe is listed. Adding a recipient is a code change plus a
backend redeploy, not a runtime toggle. Partner-facing notes are in
`apps/docs-ophis/docs/partners.md`.

## Prerequisites (do not skip verification)

1. **Ownership proof.** Confirm the requester controls the recipient address:
   a challenge message signed by the Safe (EIP-1271) or a small on-chain
   transaction from it. Do NOT take the address from a chat message or email
   body alone.
2. **Signed fee agreement** on file (rate, chains, recipient).
3. **EIP-55 checksum** the address. Reject a non-checksummed or malformed value.

## Step 1: allowlist the recipient (ingress)

1. Add the checksummed address to `PARTNER_FEE_RECIPIENT_ALLOWLIST` in
   `apps/backend/crates/app-data/src/app_data.rs`. Keep the Ophis Safe at index 0.
2. If a reduced agreed rate applies, add the recipient to `recipient_base_floor_bps`
   (the per-recipient floor keyed on the address); otherwise the default
   non-stable floor applies. Never lower a floor without a signed agreement.
3. Build and test: `cargo test -p app-data` (the partner-fee validation tests
   cover the allowlist path).
4. Open a PR. The change touches money-path validation, so it needs the standard
   review plus a Codex pass before merge.
5. Deploy the backend. The allowlist is compiled in, so it is live only after a
   redeploy of EVERY service that enforces it. That includes the ORDERBOOK
   (ingress validation runs in the orderbook's `OrderValidator` via
   `app_data_validator.validate(...)`, wired in
   `apps/backend/crates/orderbook/src/run.rs`), not only the driver/autopilot. If
   you redeploy only driver/autopilot, the live orderbook keeps the old compiled
   allowlist and keeps rejecting the new recipient at ingress. Rebuild and
   redeploy the whole backend image on the sovereign infra.
6. Confirm on-chain with a test SETTLED order, not `validate_order` and not just
   ingress acceptance. `validate_order` errors on any non-Ophis recipient (it does
   not read the backend allowlist). Ingress acceptance alone is also insufficient:
   the two enforcement points use the SAME compiled allowlist but behave
   differently, so a partial redeploy hides a gap. The orderbook rejects a
   non-allowlisted recipient at ingress; the autopilot instead DROPS a
   non-allowlisted partner-fee recipient and lets the order settle WITHOUT that
   fee (defense in depth, `apps/backend/crates/autopilot/src/domain/fee/mod.rs`).
   So if the orderbook was redeployed but the autopilot was not, a test order is
   accepted at ingress yet settles charging no own-fee. Verify the fee policy was
   actually APPLIED: check the settled trade's executed fee (or the autopilot
   logs/metrics for the applied partner fee), not just that ingress did not
   reject. This is why step 5 redeploys the WHOLE backend image.
7. Confirm the recipient is accepted at ingress AND that its fee is actually
   charged (per step 6). Ingress acceptance is not payout, so do not tell the
   partner they receive their fee yet. Proceed to Step 2 to enable and fund the
   payout, in a SEPARATE deploy from this one: never enable the payout in the same
   change that adds the backend allowlist.

## Step 2: enable and fund the own-fee payout

Step 1 only lets the fee be charged into the Ophis Safe. To pay it back to the
recipient, enable the per-recipient payout in the rebate-indexer
(`apps/rebate-indexer/src/ownFee/`). Order matters: never enable a recipient here
before its Step 1 backend allowlist deploy is live on the sovereign chain.

1. Add the recipient to `SOVEREIGN_OWN_FEE_RECIPIENTS` in
   `apps/rebate-indexer/src/ownFee/recipients.ts`. This set is the payout
   allowlist and must mirror the backend `PARTNER_FEE_RECIPIENT_ALLOWLIST` MINUS
   the Ophis Safe. It fails closed: it must never contain the Ophis Safe or the
   zero address (`assertOwnFeeRecipientsSane` throws at import time otherwise). Add
   a recipient here ONLY AFTER its Step 1 backend allowlist deploy is live; adding
   it here first would try to pay a fee the autopilot dropped (the Safe never
   received it), so keep this set TRAILING the backend allowlist, never leading it.
   Use the lowercased address.
2. Set `OWN_FEE_PAYOUT_ENABLED=true` in the rebate-indexer environment. It
   defaults to OFF; while OFF the monthly cron still ACCRUES (records what is owed
   per recipient) but PROPOSES nothing. Flipping it ON later proposes every
   un-proposed accrued batch, including back-months, so a recipient allowlisted
   while the flag was OFF is paid what accrued once it is ON.
3. Fund the sovereign chain's Ophis Safe with enough WETH to cover the owed
   payout. The payout has an over-draw guard: if the Safe's WETH balance is short
   it BLOCKS rather than proposing a partial or over-drawing batch. Top up before
   the monthly cron runs.
4. The monthly cron then accrues each recipient's charged own-fee (USD-valued from
   routed volume, not exact per-token restitution) and proposes a WETH Safe
   MultiSend from the sovereign chain's Ophis Safe. A 2-of-3 signer executes it,
   the same path as the referral payout. Confirm the executed tx before telling
   the partner it paid.

## Removing a recipient

Drop the address from the backend `PARTNER_FEE_RECIPIENT_ALLOWLIST` (reverse of
Step 1), same test + review + redeploy path, AND drop it from
`SOVEREIGN_OWN_FEE_RECIPIENTS` in the rebate-indexer so no further own-fee is paid
to it (to stop all sovereign own-fee payouts at once, set
`OWN_FEE_PAYOUT_ENABLED=false`). Removal takes effect only after the redeploy;
there is no instant kill for a compiled-in allowlist entry, so treat additions as
reviewed and deliberate.
