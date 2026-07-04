# Sovereign own-fee allowlisting (internal runbook)

How Ophis adds an integrator's own-fee recipient to the partner-fee allowlist on
the sovereign chains (Optimism 10, Unichain 130), so their stacked `partnerFee`
entry settles instead of being rejected at ingress.

Background: the self-hosted backend enforces `PARTNER_FEE_RECIPIENT_ALLOWLIST`
in `apps/backend/crates/app-data/src/app_data.rs`. `validate_partner_fees`
rejects the WHOLE order if any `partnerFee` recipient is not in that list, and by
default only the Ophis Safe is listed. Adding a recipient is a code change plus a
backend redeploy, not a runtime toggle. Partner-facing steps are in
`apps/docs-ophis/docs/partners.md` (Sovereign own-fee onboarding).

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
5. Deploy the backend (rebuild + redeploy the driver/autopilot on the sovereign
   infra). The allowlist is compiled in, so it is live only after the redeploy.
6. Confirm on-chain: preflight a test order with the recipient via the MCP
   `validate_order` tool (a clean result means the recipient is now accepted),
   or check that a small settled order routes the fee to the address.
7. Notify the partner that their recipient is live on the requested chains.

## Removing a recipient

Reverse of step 1 (drop the address), same test + review + redeploy path. Removal
takes effect only after the redeploy; there is no instant kill for a compiled-in
allowlist entry, so treat additions as reviewed and deliberate.
