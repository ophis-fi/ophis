# Ophis Design System rebuild plan

**Created:** 2026-05-23
**Owner:** Clement
**Driver:** Clement's 2026-05-22 night feedback that the site is "vibe-coded"

## Background

Across 2026-05-22 night I shipped 5 static pages (About, Legal, Brand,
Institutional, Tiers) without using:
- The Nucleus UI mockups at `/Users/scep/Desktop/website mockups/`
- Codex as a design partner

Result: each page locally defines `Title` / `Lede` / `Section` /
`FeatureCard` / `Note` styled-components. No reusable vocabulary, no
content density, no live/planned/partner labels. Clement reasonably
called it "vibe-coded."

This doc captures the corrective plan, validated by Codex on 2026-05-23
(thread `019e51d6-a53b-7923-9b94-4dfbb0d24079`).

## Phase A — Design system primitives

### A1: foundational primitives (PR #246, this PR)

Live in `apps/cowswap-frontend/src/ophis/ds/`:

- **PageShell** — page wrapper. Replaces per-page `Page` styled.main.
  Accepts `width` (narrow/medium/wide), `eyebrow`, `title`, `lede`.
  Does NOT render OphisHeader/Footer — those come from AppContainer.
- **Section** — labeled content band with H2 + optional intro + body.
  `id` prop for in-page TOC anchors.
- **Badge** — short status pill. Tones: `live` / `planned` / `beta` /
  `partner` / `draft` / `audit`.
- **Callout** — info/warning/success/danger/planned banner.
- **TextLink** — branded anchor with saffron underline + hover state.
- **InlineCode** — monospace inline `<code>` element styled with token-aware bg.
- **KeyValueList** — definition list for legal entity disclosures, contact
  info, spec sheets.

### A2: composition primitives (next PR)

- **Accordion** — collapsible content (FAQ, risk explainers).
- **MetricCard** — stat card (volume routed, chains supported).
- **FeatureGrid** + **FeatureCard** — repeated feature lists.
- **Table** — styled data table (chains × fees × API limits).

### A3: page rebuilds (after A1 + A2 reviewed)

Rewrite the 5 existing static pages using ONLY ds/ primitives.
Add content density per cow.fi reference.

Estimate: 5-8 dev-days for A3 alone.

## Phase B — Subdomain infrastructure

### B1: docs.ophis.fi

Move `/docs/index.html` to a dedicated subdomain.
- CF Pages custom domain (auto-CNAME + SSL via dashboard)
- Build a real docs app with sidebar nav, sections, API ref
- Redirect ophis.fi/docs → docs.ophis.fi

Estimate: 3-5 dev-days.

### B2: business.ophis.fi

Business portal modeled on business.1inch.com.
- Separate CF Pages custom domain
- Content: product/API overview, integration paths, rate limits, SLA,
  contact/sales, legal/API terms

Estimate: 3-5 dev-days.

## Phase C — Gamified pages (static-pretend v1)

Per Clement's 2026-05-22 directive: build PAGE SHELLS with wallet-aware
connect + mock data + "coming soon" banners.

### C1: /profile

- Wallet-connect-aware page (read account from wagmi via useWalletInfo)
- Shows: address, ENS, trade count (mock), chains used (mock), current
  tier (mock = "Stargazer"), saved destinations
- "Recent trades" panel with empty state

### C2: /missions

- Partner mission list as Mission Cards
- States: not-started / in-progress / completed / claimable
- v1 ships ALL missions as `planned`

### C3: /earn

- Like Missions but for ongoing rewards (LP boosts, partner perks)
- Clearly labeled "coming soon" / "early preview"

### C4: Gamification framework

Per Codex's fintech UX best practices:
- Reward meaningful actions, not random clicks
- Make progress explain product value
- Prefer wallet-specific achievements over public leaderboards
- Use levels as recognition, not financial promises
- Show exact eligibility criteria
- Separate education missions from trading missions
- Use "claimable" only when rewards are actually funded
- Keep risk disclosures close to reward CTAs

Estimate for C1-C3: 3-4 dev-days for static-pretend v1.

## Risks documented (per Codex review)

- "Earn rewards from partners" requires REAL partner agreements
- "Track your trade volume across chains" requires reliable indexer infra
- "Discounted fees / priority queue / API quota" requires BACKEND enforcement
- "OTC routing / institutional terms" implies a sales/legal process
- "Audited Ophis-specific solver wiring" requires specific audit artifacts
- Gamified trading can create regulatory + trust risk
- Subdomains add maintenance burden — broken docs harm institutional credibility

## Timeline (working estimate)

- Phase A1 (this PR): 0.5 day ← shipped 2026-05-23
- Phase A2 (next PR): 1 day
- Phase A3 (page rebuilds): 5-8 days
- Phase B (subdomains): 6-10 days
- Phase C1-C3 (static gamified): 3-4 days
- **Total static-pretend delivery: ~16-23 dev-days**
- Real backend integration: +25-45 days

## Cross-refs

- 2026-05-22 brand sprint memory (`2026-05-22-brand-sprint.md`)
- Codex design-partner review thread `019e51d6-a53b-7923-9b94-4dfbb0d24079`
- Nucleus UI Lite mockups: `/Users/scep/Desktop/website mockups/`
