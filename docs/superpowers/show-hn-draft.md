# Show HN draft — Greg

**Status:** draft, ready to fire when Clement gives the signal. Do not submit until brand decision (D1) is final or codename `greg` is explicitly endorsed for launch.

## Title

≤ 80 characters; HN's title field caps near there. Two options:

> Show HN: Greg – DCA and TWAP on CoW Protocol with downloadable receipts

(73 chars — preferred)

> Show HN: Greg – power-user CoW Swap with MEV-proof receipts and DCA

(67 chars — alternate)

## URL

`https://greg-clementfrmds-projects.vercel.app` (production Vercel alias) — replace with real domain if D2 is decided before submission.

## Body (~ 200 words, no Markdown — HN renders plain text)

Hi HN,

I built Greg — a frontend over CoW Protocol focused on retail power users and small DAO treasuries. Same MEV-protected gasless execution as cow.fi, but with three things their UI doesn't do:

1. DCA / TWAP from a top-level CTA on the home page (no spelunking through "Advanced Orders").
2. Downloadable MEV-proof execution receipts on every settled order — JSON for machines, PDF for humans. Includes solver competition data, settlement tx hash, and surplus vs the original quote. Designed for treasury accountants who keep asking "did we get a fair price?"
3. Safe app integration so multisig treasurers can batch-approve.

Live on 10 chains (Ethereum, Gnosis, Base, Arbitrum, Polygon, Avalanche, BNB, Linea, Plasma, Ink). Free for users. We monetize via CoW Protocol's existing partner-fee mechanism (5 bps per swap, paid to us by CoW DAO weekly in WETH) — same way Matcha makes money on top of 0x.

Open-source under GPL-3.0. The repo isn't public yet (still cleaning up before publishing) but I'm happy to share specifics in this thread.

Looking for feedback on:

- The receipt schema. Useful for treasury accounting, or am I solving a problem nobody has?
- Anyone running a DAO treasury who wants to be the first user?

## Pre-drafted OP follow-up comment

Post within 30 seconds of submission, as the first comment under the post:

> Some technical details for HN:
>
> Greg is currently a fork of cowprotocol/cowswap (GPL-3.0) with a small patch to default the partner-fee `appData` parameter to a Greg-controlled recipient when widget params don't supply one. The patch lives at one file and is tracked as a divergence so we can pull upstream cowswap updates cleanly: https://github.com/san-npm/greg/blob/main/apps/frontend/.greg-divergences.md
>
> CoW DAO disburses 75 % of the partner fee weekly; the other 25 % is their "service fee". This is identical to how every other CoW frontend integrator works — we don't get a special deal.
>
> The receipt module (the new Greg-only piece) is at apps/cowswap-frontend/src/modules/mevReceipt — pure-function buildReceipt + jspdf-based exportPdf + a deterministic JSON exporter (sorted keys, so two receipts with the same data hash to the same file — useful for accounting reconciliation).
>
> Architecture FAQ:
> - Why not fork the protocol contracts? CoW's GPv2Settlement is permissioned via an AllowListAuthentication contract controlled by a 14-signer Gnosis Safe. Self-hosted settlement on CoW's chains requires DAO approval (multi-week governance process). Phase 3 of the roadmap deploys CoW's audited bytecode unchanged on chains they haven't deployed to (e.g., MegaETH), under our own allowlist — that gets us full sovereignty without an audit ($30-150K) or solver bootstrapping headache for chains where we'd be the only intent broker anyway.
> - Why bps not surplus? Predictable for treasuries. Surplus capture is a separate dimension; CoW already does it and we ride that.

## Anticipated Q&A — prepared answers

| Q | A |
|---|---|
| "Isn't this just cowswap with extra steps?" | The cowswap UI is general; we're vertical (DCA + receipts + Safe-first treasury UX). On 7 of the 10 supported chains the underlying TWAP infrastructure is the same; we differ on what we surface to the user, what we let them export, and how we onboard treasuries. |
| "How is this not a rug? Where's the audit?" | Greg doesn't run any custom Solidity. Every order settles via CoW Protocol's audited GPv2Settlement (Trail of Bits, Gnosis, G0 Group). We only added frontend code and one line of partner-fee config. There's nothing for a rug to rug. |
| "What happens if CoW changes the partner-fee mechanism?" | We migrate to our own settlement contracts on a chain they haven't deployed to. Phase 3 of our roadmap. The forked services stack we maintain is exactly the runtime we'd use when that day comes. |
| "Why no token?" | Because tokens go to zero. (Quoting Clement.) |
| "Why no fiat on/off-ramp?" | Out of scope. Greg is non-custodial intent-broker UX; if you need fiat, we point you at one of the existing on-ramp providers. Different product. |
| "What are the limits per swap?" | None we set. CoW's solver network handles the size; we're routing-layer only. Treasury-sized swaps welcome — the receipt format is built for them. |
| "Can I run this for my DAO right now?" | Yes. The deployed app is live; if you have a Safe, treat it like any other Safe app. Hit me up in this thread or open an issue if you want help wiring it into a treasury workflow. |
| "Open source?" | GPL-3.0. The cowswap fork inherits the upstream license; our additions ship under the same. Repo public soon after Phase 3 ships. |
| "Roadmap?" | docs/superpowers/specs/2026-05-03-greg-design-amendment.md in the repo (will be public soon). Short version: Phase 3 ships sovereign settlement on MegaETH; Phase 4 opens a public routing API. |

## Timing

Best HN submission window:
- **Tuesday or Wednesday**, 8:00–10:00 EST (best traffic for a "Show HN")
- **Avoid:** weekends (low traffic), Mondays (everyone posts then), Friday afternoons.

Pre-warm: at least 3 friendly accounts ready to upvote in the first 30 minutes (HN's algorithm strongly favours early velocity).

Don't post a Product Hunt launch the same day — they cannibalise each other's first-day attention. Stagger by 2–4 days.

## What we measure on launch day

- Front-page minutes on HN (target: 4+ hours)
- Inbound retail signups in the first 24h (target: 500+ unique visits)
- Treasury / integrator inbound DMs (target: 1+, however many we get)
- Negative feedback that's repeated by 3+ commenters (signal something to fix)

## Out of scope for this draft

- Visual mock or hero image — Phase 2.6 brand task.
- Embed widget showcase — Phase 4.
- Pricing / tier explanation — we're free for retail; B2B / API tiers are Phase 4 and don't need to be in the launch post.
