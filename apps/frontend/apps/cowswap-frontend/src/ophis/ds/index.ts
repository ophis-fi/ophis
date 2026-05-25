/**
 * Ophis Design System — Phase A primitives.
 *
 * Co-located with the Ophis branded components (intent landing, header,
 * footer). These are STATELESS, PRESENTATION-ONLY components meant to be
 * composed into pages — no business logic, no API calls, no React state
 * machinery beyond standard a11y patterns.
 *
 * Build order per Codex 2026-05-23 design review:
 *   1. PageShell + Section + Badge + Callout  ← Phase A1 (this PR)
 *   2. Accordion + MetricCard + FeatureGrid + Table  ← Phase A2 (next PR)
 *   3. DocsLayout + SidebarNav  ← Phase B (docs subdomain)
 *
 * Then existing pages (About, Legal, Brand, Institutional, Tiers) get
 * rewritten to use these primitives. Then Profile / Missions / Earn get
 * built using a subset of these + dashboard primitives.
 *
 * Design references:
 *   - Nucleus UI Lite (mockup folder at `/Users/scep/Desktop/website mockups/`)
 *   - tokens.ts in this folder for the brand color ramps
 *   - 2026-05-23 design-partner review by Codex (preserved in PR #246 description)
 */

export { PageShell } from './PageShell'
export type { PageWidth } from './PageShell'

export { Section } from './Section'

export { Badge } from './Badge'
export type { BadgeTone } from './Badge'

export { Callout } from './Callout'
export type { CalloutTone } from './Callout'

export { TextLink } from './TextLink'

export { InlineCode } from './InlineCode'

export { KeyValueList } from './KeyValueList'
export type { KeyValueRow } from './KeyValueList'

// Phase A2 (PR #247, 2026-05-23) — composition primitives.
export { Accordion, AccordionGroup } from './Accordion'

export { MetricCard } from './MetricCard'
export type { TrendDirection } from './MetricCard'

export { FeatureGrid, FeatureCard } from './FeatureGrid'

export { Table, Th, Td, RowTh, Tr, Thead, Tbody } from './Table'
