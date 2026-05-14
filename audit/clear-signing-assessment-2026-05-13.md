# Clear Signing (ERC-7730) — Ophis Integration Assessment

**Date:** 2026-05-13
**Decision:** **WAIT** — with one cheap "GO" carve-out for the user-order surface (see §4).
**Author:** Claude (research-only; verify before shipping)

---

## 1. What clear signing actually is (technical, not marketing)

- **Standard:** ERC-7730 ("Structured Data Clear Signing Format"), still in **Draft** status on the Ethereum Standards Track. Originally authored by Ledger, transferred to Ethereum Foundation stewardship.
- **Public launch:** Ethereum Foundation umbrella announcement **2026-05-12** (yesterday). The technical work and registry pre-date this by ~18 months; the announcement is mostly a re-branding + governance handoff.
- **Mechanism:** a JSON descriptor file (no contract changes) that wallets read at signing time to render human-readable labels instead of raw calldata / raw EIP-712 fields.
- **Binding:** descriptors bind to either (a) a smart contract via `{chainId, address}` deployments, or (b) an EIP-712 domain (`name`, `version`, optionally `chainId`/`verifyingContract`). **A single descriptor can cover N chains** by listing all deployments in one array.
- **Matching:** wallet computes `keccak256(typeSignature)[:4]` for calldata or matches `encodeType()` for EIP-712, then looks up the descriptor's display rules.
- **Field formats supported:** `tokenAmount`, `date`, `raw`, `amount`, `addressName`, plus `visible: never` to hide noise (salt, nonce). Path syntax uses dot notation with `#` (data) / `$` (spec) / `@` (container) roots.
- **Distribution:** PR into `LedgerHQ/clear-signing-erc7730-registry` (the EF org alias `ethereum/clear-signing-erc7730-registry` points at the same repo). Automated CI validates schema, ABI consistency, and contract verification on the listed chains.

## 2. Who actually consumes the registry (this is the gating question)

Verified from public sources as of 2026-05-13:

| Wallet | Status | Notes |
|---|---|---|
| Ledger (hardware + Ledger Live) | **Live, production** | Has been shipping ERC-7730 descriptors for ~18 months. This is the original consumer. |
| Trezor | Committed, **target June 30, 2026** | Partial decoding in Q2 2026, full clear-sign end of Q2. |
| Rabby | **Joined initiative, no shipped consumer yet** | Announced support in principle (X/Twitter). No release notes confirming registry consumption. |
| MetaMask | **Joined initiative, no shipped consumer yet** | Public list-member as of EF announcement. Unclear whether delivered as built-in or Snap. No timeline. |
| WalletConnect / Safe / Fireblocks / Keycard | Initiative members | No clear end-user wallet path. |

**Bottom line on consumption:** Ledger + Ledger-Live users are the only group that gets real benefit *today*. Everyone else is months away.

## 3. CoW Protocol upstream status

I checked:
- `LedgerHQ/clear-signing-erc7730-registry` PRs (all states) for "cow", "gpv2", "cowswap" — **zero hits**.
- `registry/` directory contents — 44 protocols, **no `cow` / `cowprotocol` entry**.
- `cowprotocol/*` GitHub org issues + code search for "7730", "clear sign", "clearsign" — **zero hits** (only an unrelated Cargo.lock checksum collision).

**Conclusion: CoW Protocol upstream has done nothing on ERC-7730 as of 2026-05-13.** We do *not* inherit anything by sitting on the upstream fork. If we want clear-signing on Ophis, we ship it ourselves — or we wait for CoW to do it.

Two important implications:
1. A CoW Protocol ERC-7730 descriptor would land in `registry/cowprotocol/eip712-GPv2Order.json` and **automatically cover Ophis too**, because the GPv2Settlement is deployed at the same deterministic address (`0x9008D19f58AAbD9eD0D60971565AA8510560ab41`) and uses the same EIP-712 domain (`Gnosis Protocol` v2) across every chain it lives on. So whether we add chainIds 10 (Optimism) and the MegaETH ID ourselves, or we wait for CoW DAO to add them, the *content* of the descriptor is identical to mainnet CoW.
2. We could submit a descriptor *as the Ophis team* listing the GPv2Settlement deployments on Optimism + MegaETH. Whether the registry CI accepts it without CoW DAO endorsement is unclear (no precedent I could find for a non-protocol-owner submission).

## 4. Per-surface assessment

### Surface 1 — User wallet signs EIP-712 GPv2 Order
- **Applies?** Yes, textbook fit. UniswapX LimitOrder and 1inch Limit Order are in the registry with ~50-line EIP-712 descriptors that render exactly the labels a Ophis user wants ("Send", "Receive minimum", "Approval expire").
- **Effort:** One JSON file (~60 lines). Estimate **2–4 hours** for a working draft + ~1 day for PR back-and-forth with Ledger CI. Reference templates: `registry/1inch/eip712-1inch-limit-order.json` and `registry/uniswap/eip712-UniswapX-LimitOrder.json`.
- **Impact:** Better Ledger-user UX (today). Almost-but-not-quite useless for everyone else until Rabby/MetaMask ship a consumer (months out). **Note:** even with no descriptor, MetaMask + Rabby already render the *raw* EIP-712 fields legibly because the field names (`sellToken`, `buyToken`, `sellAmount`, `buyAmount`) are self-documenting — so the UX delta for non-Ledger users is small.
- **Upstream doing it?** No. But a descriptor we submit benefits all of CoW Protocol, not just Ophis (free goodwill, low risk of upstream conflict).
- **Verdict:** **GO, but cheap** — see §6 recommendation.

### Surface 2 — Operator HW wallet signs deploy txs (transferOwnership, setManager, addSolver, raw cast send --create)
- **Applies?** Partial. `transferOwnership` / `setManager` / `addSolver` are typed calldata against known contracts — fittable with ERC-7730. **`cast send --create` (raw contract deploy) is NOT clear-signable**: there is no ABI selector, just raw init code. Ledger will always show this as a blind sign.
- **Effort:** Higher than Surface 1. Need calldata descriptors for our authority/admin contracts + GPv2AllowListAuthentication. Tens of hours.
- **Impact:** Low — these are one-shot deploys, Clement reviews tx data out-of-band on a verified RPC/explorer, and the threat model is already "you typed the right script and your simulation matched". Clear-signing does not change the deploy threat model meaningfully.
- **Upstream doing it?** No.
- **Verdict:** **NO-GO.** Low frequency, low marginal value, raw-create is unfixable, and we already mitigate with simulation + manual review.

### Surface 3 — Safe co-signers sign Safe transactions
- **Applies?** Yes — **and already covered.** `registry/safe/eip712-Safe-1.4.1.json` (+ 1.3.0 / 1.5.0 + SafeL2 variants) is already in the registry and live on Ledger. Ledger users co-signing on the partner-fee or protocol Safe **already get clear signing** for the outer Safe envelope.
- **Effort:** Zero for the Safe envelope. The *inner* call (`transferOwnership`, etc.) decode depends on whether those contracts have their own descriptors — same problem as Surface 2.
- **Impact:** Already inherited.
- **Upstream doing it?** Safe DAO already shipped it.
- **Verdict:** **Already done. No action required.**

### Surface 4 — Rebate-indexer Safe-proposer signs Safe txs (automated MultiSendCallOnly)
- **Applies?** Same as Surface 3 — Safe envelope is clear-signed; inner ERC-20 `transfer` calls inherit clear-signing from the Permit/ERC-20 descriptors that already exist for ~70 token deployments (including USDC/USDT on Optimism). `MultiSendCallOnly` itself doesn't appear to have a registry entry — fixable but low priority because the proposer is automated, not a human reviewer.
- **Effort:** Trivial. The signing is done by an automated proposer (no human reviews on a hardware wallet); the human reviewers are the Safe co-signers, who fall under Surface 3.
- **Impact:** Effectively zero — automated signer doesn't care about UX. Co-signer review experience is Surface 3.
- **Verdict:** **NO-GO** (out of scope — automation surface, not a human UX surface).

## 5. Risks / open questions

- **Open:** Will the registry CI accept a CoW Protocol descriptor PR submitted by `san-npm` (i.e., not from `cowprotocol` org)? Registry has no explicit "must be project owner" rule, but social pushback is plausible. **Lower-risk path:** submit it as `cowprotocol` (fork CoW upstream, open PR via the CoW DAO governance forum first) — slower but no contention.
- **Open:** MegaETH chainId — registry CI validates "contract is verified on the listed chainIds"; if MegaETH explorers aren't supported by the CI's verification service yet, the PR may fail. **Mitigation:** ship the Ethereum/Optimism-only descriptor first (the bulk of the value), backfill MegaETH later.
- **Risk:** ERC-7730 is still **Draft** status. Schema may change (`erc7730-v2.schema.json` already supersedes v1). Maintenance cost is real if v3 lands.
- **Risk (light):** if Ledger eventually has a "registry merkle root" baked into firmware (no evidence today but flagged in the spec's "future directions"), a non-CoW-DAO PR to the CoW namespace might be rejected during a future cleanup.

## 6. Recommendation

**WAIT on three of four surfaces; GO cheaply on Surface 1 only IF we have free capacity.**

- **Surface 2 — NO-GO.** Wrong tool for the threat model.
- **Surface 3 — already inherited from Safe.** No work needed.
- **Surface 4 — out of scope** (automation).
- **Surface 1 — conditional GO.**

**Shortest path on Surface 1 (~4 hours of work):**
1. Copy `registry/1inch/eip712-1inch-limit-order.json` as a starting template.
2. Replace domain with `{ name: "Gnosis Protocol", version: "v2" }` and deployments with the full GPv2Settlement address list (Ethereum, Gnosis, Arbitrum, Base, Optimism, MegaETH, plus all other CoW-deployed chains — the address is the same on all of them).
3. Write the `display.formats` block for the `Order(...)` type-hash. The fields a Ledger user wants to see: `sellToken`, `sellAmount`, `buyToken`, `buyAmount` (rendered as tokenAmount pairs labeled "Send" / "Receive minimum"), `receiver` ("To"), `validTo` ("Expires"). Hide salt, partiallyFillable, kind, feeAmount, app data.
4. Submit PR via the CoW DAO forum first to avoid the "who is san-npm" friction. Frame as: "Adds clear-signing for CoW Protocol orders — also covers Ophis Finance, a CoW fork on Optimism + MegaETH."

**Trigger to revisit the WAIT decision:**
- Rabby OR MetaMask ships a *consumer* of the registry (not just initiative membership). Watch their changelogs; check again Q3 2026.
- CoW DAO opens its own discussion on ERC-7730 (governance forum search "clear signing"). If yes, drop our descriptor effort and wait.
- A user with a Ledger reports their Ophis trade was blind-signed and complains. (Direct signal of pain.)

**Cost summary:** If we do Surface 1, total spend is ~half a day of engineering + 1–2 weeks of PR cycle time. Ongoing maintenance: re-PR when ERC-7730 schema bumps (probably annual). The upside is real but small (Ledger users only, and only until the order UX is improved natively). **Not a priority before Phase 4 self-hosted orderbook.**

## 7. Sources

- [Clear Signing build guide](https://clearsigning.org/build/)
- [Ethereum Foundation announcement, 2026-05-12](https://blog.ethereum.org/2026/05/12/clear-signing-announcement)
- [ERC-7730 spec (Draft)](https://eips.ethereum.org/EIPS/eip-7730)
- [Registry: LedgerHQ/clear-signing-erc7730-registry](https://github.com/LedgerHQ/clear-signing-erc7730-registry)
- [Ethereum.org tutorial — Add clear signing to your protocol](https://ethereum.org/developers/tutorials/clear-signing/)
- [Ledger Developer Portal — manual implementation](https://developers.ledger.com/docs/clear-signing/for-dapps/manual-implementation)
- [CoW Protocol signing schemes](https://docs.cow.fi/cow-protocol/reference/core/signing-schemes)
- Reference descriptors inspected locally: `registry/1inch/eip712-1inch-limit-order.json`, `registry/uniswap/eip712-UniswapX-LimitOrder.json`, `registry/safe/eip712-Safe-1.4.1.json`, `registry/permit/eip712-permit-optimism-usdc.json`
