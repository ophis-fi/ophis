# Product Hunt draft — Greg

**Status:** draft, ready to fire when Clement gives the signal. Stagger 2–4 days from the Show HN post; Sunday-evening submission for Monday launch is PH's standard pattern.

## Tagline (≤ 60 chars)

Three options, pick one:

> DCA and TWAP for power users — MEV-protected, gasless

(54 chars — preferred; matches Show HN voice)

> The trader's CoW Swap. DCA, MEV-proof receipts, Safe-first

(57 chars — sharper positioning, riskier framing)

> Schedule your crypto buys without losing to MEV bots

(53 chars — most retail-friendly)

## Description (≤ 260 chars)

Greg is DCA + TWAP on top of CoW Protocol's solver network. Set up a recurring buy that's MEV-protected and gas-free; download a receipt your treasury auditor will accept. Free for users on 10 chains. Built for power users and DAO treasuries.

(247 chars)

## Topics (PH categorisation)

Pick 3-4:
- Crypto
- DeFi
- Trading
- Productivity
- Open Source

## First-day media — to-do list

These need to be produced before launch. Rough fidelity is fine; Phase 2.5 doesn't include design polish, so screenshots from the live deployment are acceptable.

- [ ] **Hero GIF** (mandatory for PH front page): home page → click "Set up a DCA" → fill form (sell WETH, buy COW, every 7 days, 10 parts) → confirmation screen. 12–18 sec, < 2 MB.
- [ ] **Screenshot 1:** Receipt PDF download for a fulfilled order (ideally a real on-chain trade, not a mock).
- [ ] **Screenshot 2:** Greg loaded inside a Safe iframe (`app.safe.global/apps/open?appUrl=...`).
- [ ] **Screenshot 3:** TWAP order in flight — e.g., the cowswap "Open orders" view showing 1/4 child orders fulfilled.
- [ ] **(Nice to have) Screenshot 4:** `api.cow.fi/.../orders/<uid>` response highlighting `fullAppData.metadata.partnerFee` — proof the partner-fee mechanism is live.

## Maker comment (pinned, posts immediately)

> Hey PH 👋 maker here.
>
> Greg is what happens when you take CoW Protocol's MEV-protected, gasless solver network and build a thin frontend specifically for two underserved users: power-user retail (people who want to DCA without paying 25 bps to Uniswap UI) and DAO treasuries (people who need to hand a receipt to an auditor that says "we got a fair price, here's the solver competition").
>
> Same execution quality as cow.fi. Different surface area:
> – DCA / TWAP from a top-level CTA, not buried under "Advanced Orders"
> – Downloadable MEV-proof receipts (JSON for software, PDF for accounting) on every settled trade
> – Safe-app-first, so multisig treasurers can batch approvals
> – 10 chains: ETH, Gnosis, Base, Arbitrum, Polygon, Avalanche, BNB, Linea, Plasma, Ink
>
> We make money via CoW Protocol's existing partner-fee mechanism (5 bps per swap, paid weekly in WETH by CoW DAO). Same model Matcha uses on top of 0x. Free for users — pricing scales with use, not subscription.
>
> Built mostly with AI assistance — happy to dig into the architecture / what we kept from cowswap upstream / what we built on top, if anyone's curious. Roadmap up next is a sovereign deployment on MegaETH where we're the only intent broker on a chain CoW hasn't reached.
>
> Feedback wanted, especially from people who've actually run a DAO treasury swap and got annoyed at how the receipt-equivalent felt afterwards. 🐮

## Launch timing

- **Submit:** Sunday evening (US-east time), no later than 11pm.
- **Launch goes live:** Monday 00:01 PST.
- **Top spot duration target:** 4+ hours in top 5.
- **Pre-warm:** 5–10 community members lined up to upvote in the first hour. (A trickle of upvotes over time matters more than a burst — PH's algo penalises burst patterns.)
- **Coordinate with Show HN:** posted 2–4 days earlier (so PH gets the second-wave traffic, not the first).

## Hunter

Decision: Clement self-hunts (preferred — better signal for PH algo), or recruit a hunter with PH following ≥ 1k.

## What we measure on PH launch day

- Final ranking on launch day (target: top 5; stretch: #1 of the day)
- Upvote count (target: 200+; stretch: 500+)
- Comment quality — count of substantive technical comments (>50 chars), not 👍 emojis
- Click-through to greg from PH (target: 10% of upvoters)
- Inbound DMs from potential treasury / integrator partners (target: 1+)

## Out of scope for this draft

- Branded landing page — current Vercel URL works for PH; brand work is a Phase 2.6 task.
- Logo / hero image polish — placeholder SVG in `apps/cowswap-frontend/public/greg-icon.svg` is acceptable for PH submission; replace before brand-defining marketing pushes.
- Pricing tier explanation — single PH listing is for the free product. T2 (treasury) and T3 (API) tiers go up via separate PH launches if/when they ship.
