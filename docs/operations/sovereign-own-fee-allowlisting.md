# Sovereign own-fee allowlisting (internal runbook)

How Ophis adds an integrator's own-fee recipient to the partner-fee allowlist on
the sovereign chains (Optimism 10, Unichain 130), so their stacked `partnerFee`
entry is not rejected at ingress.

> IMPORTANT: allowlisting is only the INGRESS gate. It lets the order settle; it
> does NOT route the fee to the partner. On the sovereign chains the fee policy
> drops the recipient (`Policy::Volume { factor }` in
> `apps/backend/crates/autopilot/src/domain/fee/policy.rs`) and the settlement
> buffer is swept to a SINGLE Safe (`SweepSettlementBuffer.s.sol` /
> `infra/*/scripts/sweep-to-safe.sh`, default the Ophis Safe), with no
> per-recipient split. So an allowlisted third-party recipient's fee accrues to
> the Ophis Safe, not to them. Do NOT tell a partner that allowlisting alone
> means they receive their own fee on the sovereign chains: per-recipient payout
> is a separate, not-yet-built path. Allowlist a third party only when there is a
> reconciliation/payout arrangement, or for an Ophis-controlled recipient.

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

## Steps

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
7. Notify the partner that their recipient is accepted at ingress. Remember this
   does NOT mean their fee is routed to them (see the payout note at the top);
   confirm the reconciliation/payout arrangement separately.

## Removing a recipient

Reverse of step 1 (drop the address), same test + review + redeploy path. Removal
takes effect only after the redeploy; there is no instant kill for a compiled-in
allowlist entry, so treat additions as reviewed and deliberate.
