# Ophis — Brand Foundations Spec

> **Date:** 2026-05-06
> **Owner:** Clement (san-npm)
> **Source:** Nucleus UI Lite (Gumroad, Lite/free tier) + brand brief 2026-05-06
> **Implements:** `apps/frontend/apps/cowswap-frontend/src/ophis/tokens.ts`

---

## 1. Summary

Ophis's visual system inherits its **structure** (token naming, scale steps, ramp shape, spacing rhythm) from Nucleus UI Lite. Token **values** start as Nucleus defaults (purple brand, light-mode only) and will diverge as the brand sharpens.

Nucleus's role is the chassis. Ophis's role is everything that makes Ophis *Ophis*: mascot/persona, copy voice, signature sound, motion language, the surplus-receipt artifact, the DCA/TWAP builder UI.

## 2. License

**Source:** Nucleus UI Lite, Gumroad. Lite tier is the *free* tier; PRO components are off-limits without a PRO purchase.

**What we use vs. don't:**

| Page / asset | License status | Use? |
|---|---|---|
| `Global Colors`, `Typography`, `Spacing`, `Corner Radius`, `Shadow`, `Stroke` | Foundation tokens — values referenced, not redistributed | ✅ |
| Pages tagged `(Core)` (Accordion, Notification/Status Badges, Aspect Ratios) | Lite-licensed components | ✅ |
| `Free Dashboard Patterns/Styles`, `Free Patterns`, `Dashboard Structure`, `Layout Grids` | Free patterns | ✅ |
| Icon sets (Alerts, Arrows, Communication, Ecommerce, Security, Shapes, Users, flags) | Lite icons | ✅ (verify icon set redistribution clause before bundling raw SVG) |
| Pages titled `Documentation_ X — Upgrade to Nucleus UI PRO...` | PRO tier — locked | ❌ |
| Components labelled "Editable version is available on PLUS" | PRO tier — locked | ❌ |

**Action item:** confirm exact Lite license terms on the Gumroad listing before mainnet (commercial use clause, attribution requirement, redistribution clause for icons).

## 3. Color tokens

### Ophis brand palette — sunset coral (10-step)

Derived from the kit's gradient card studies (`Auto Layout-2.svg`). Saturated peak `#E6766A` anchors `brand/60`. Strategic rationale: every DEX aggregator (1inch, Velora, Jumper, Bungee, Matcha) lives in the cool blue/purple/teal cluster; warm tones make Ophis unmistakable in a competitive screenshot.

| Token | Hex | Use |
|---|---|---|
| `brand/10` | `#FFF3EE` | Subtle accent bg, badge bg, hover wash |
| `brand/20` | `#FFDFD3` | Subtle accent bg |
| `brand/30` | `#FFBDA8` | Decorative |
| `brand/40` | `#FF9579` | Disabled, focus ring |
| `brand/50` | `#FF7A60` | Dark-mode primary |
| `brand/60` | `#E66A55` | **Light-mode primary action** |
| `brand/70` | `#C2503D` | Primary hover, accent text |
| `brand/80` | `#993627` | Primary pressed |
| `brand/90` | `#5C1D14` | Dark-mode subtle accent bg |
| `brand/100` | `#2A0B07` | Deepest accent |

### Ophis secondary accent — magenta/rose (10-step)

For highlights, gradient stops, illustration. Used sparingly. Anchor `#C73D6C`.

| Token | Hex | Use |
|---|---|---|
| `accent/10` | `#FFF0F6` | Wash |
| `accent/20` | `#FFD4E2` | — |
| `accent/30` | `#FFA9C2` | — |
| `accent/40` | `#F47AA0` | — |
| `accent/50` | `#E55A88` | — |
| `accent/60` | `#C73D6C` | Secondary action / hover |
| `accent/70` | `#A02855` | — |
| `accent/80` | `#7A1A40` | — |
| `accent/90` | `#4A0E28` | Dark-mode subtle accent |
| `accent/100` | `#220612` | — |

### Sunset gradient (hero / marketing / receipts only — NOT UI affordances)

```
linear-gradient(135deg, #FF8A52 0%, #FF6B5A 30%, #E55A88 65%, #A44E91 100%)
```

Used on landing hero, MEV-proof receipt artwork, app icon background, splash screens. Never on buttons, inputs, or any element with click affordance — those use solid `brand/60`.

### Neutral palette (10-step + white)

| Token | Hex | Use |
|---|---|---|
| `white` | `#FFFFFF` | Surface (light mode) |
| `grey/10` | `#F4F6F7` | Subtle bg (light mode), text primary (dark mode) |
| `grey/20` | `#E8EBEB` | Border subtle (light), text secondary (dark) |
| `grey/30` | `#DADDDE` | Border default (light) |
| `grey/40` | `#C1C4C6` | — |
| `grey/50` | `#898D8F` | Text muted (both modes) |
| `grey/60` | `#6E7375` | — |
| `grey/70` | `#53575A` | Text secondary (light), border default (dark) |
| `grey/80` | `#2F3133` | Subtle bg (dark) |
| `grey/90` | `#1F2224` | Surface (dark) |
| `grey/100` | `#131214` | Page bg (dark), text primary (light) |

### Functional palettes (success / warning / danger / info)

10-step ramps each. Primary anchors:
- **green** (success): `green/50` `#23A15D` light · `green/40` `#51C285` dark
- **yellow** (warning): `yellow/40` `#ED9B16` light · `yellow/30` `#FFD84D` dark
- **red** (danger): `red/50` `#FF5226` light · `red/40` `#FF9175` dark
- **blue** (info): `blue/50` `#3084FF` light · `blue/40` `#75B1FF` dark

## 4. Typography — paired display + body

Both faces are SIL Open Font License (free, commercial OK, no attribution required).

| Role | Family | Why |
|---|---|---|
| Display (Display 1/2, H1) | **Fraunces** | Variable serif with SOFT axis; warm, editorial, has character. Pairs naturally with the sunset palette. Replaces CoW's licensed StudioFeixen. |
| Body (H2–H6, body, label) | **Plus Jakarta Sans** | Variable geometric humanist sans, tabular figures, neutral but distinctive. Lifted from Nucleus. |
| Mono (data, hashes, addresses) | **JetBrains Mono** | Variable, free, ligature-aware, designed for code/data. Better than Inter Mono for tx-hash readability. |

- **Sizes**: `xs 12 · sm 14 · md 16 · lg 18 · xl 24 · 2xl 32 · 3xl 40 · 4xl 64`.
- **Weights**: 300/400/500/600/700.
- **Line height**: 120% display & heading, 150% body.

| Style | Family | Size | Weight | Line height |
|---|---|---|---|---|
| Display 1 | Fraunces | 64 | 700 | 120% |
| Display 2 | Fraunces | 40 | 700 | 120% |
| Heading 1 | Fraunces | 32 | 700 | 120% |
| Heading 2 | Plus Jakarta | 24 | 700 | 120% |
| Heading 3 | Plus Jakarta | 18 | 700 | 120% |
| Heading 4 | Plus Jakarta | 16 | 700 | 120% |
| Heading 5 | Plus Jakarta | 14 | 700 | 120% |
| Heading 6 | Plus Jakarta | 12 | 700 | 120% |
| Body LG/MD/SM/XS | Plus Jakarta | 18/16/14/12 | 400 | 150% |
| Label LG/MD/SM/XS | Plus Jakarta | 18/16/14/12 | 700 | 150% |
| Mono | JetBrains Mono | 14 | 400 | 150% |

## 5. Spacing, radius, stroke

- **Spacing** (4-step): `0, 4, 8, 12, 16, 24, 32, 40, 48, 56, 64, 72, 80`.
- **Radius**: `none 0 · sm 4 · md 8 · lg 16 · xl 32 · full 9999`.
- **Stroke**: `none 0 · sm 1 · md 2 · lg 4 · xl 8`.

## 6. Shadow

Three elevations + focus, derived (Nucleus exact values not yet measured at pixel precision):
- `low` — 0 1 2 rgba(0,0,0,.04) + 0 1 3 rgba(0,0,0,.06)
- `medium` — 0 4 6 rgba(0,0,0,.04) + 0 8 16 rgba(0,0,0,.06)
- `high` — 0 12 24 rgba(0,0,0,.08) + 0 24 48 rgba(0,0,0,.12)
- `focus` — 0 0 0 3px brand/40

## 7. Decisions locked (2026-05-06)

| # | Decision | Choice |
|---|---|---|
| 1 | Accent color | **Sunset coral** — `#E66A55` primary (`brand/60`), `#C73D6C` secondary accent. Derived from `Auto Layout-2.svg`. |
| 2 | Typeface | **Fraunces (display) + Plus Jakarta Sans (body) + JetBrains Mono (data)** — all OFL. |
| 3 | Modes | **Light + dark from day 1.** Light = canonical Nucleus values. Dark = derived. |
| 4 | Mascot/motif | **TBD** — searching. Does not block tokens or component work. |
| 5 | Ophis logo | TBD — `public/greg-icon.svg` is a placeholder. |

## 8. Next steps

1. Decide §7 items 1–3.
2. Wire `tokens.ts` into `theme/getCowswapTheme.ts` (replace `baseTheme()` overrides) + emit CSS custom properties for runtime theming.
3. Replace `fonts.css` — drop StudioFeixen (license risk), load Plus Jakarta Sans (OFL).
4. Sweep ~480 source references to cow/🐮/moo (separate spec — see `2026-05-02-ophis-design.md` audit).
5. Map Nucleus Core components → cowswap fork primitives one by one (Button, Input, Card, Tabs, Modal, Toast, Badge, Tooltip, Dropdown, Switch, Checkbox, Radio).
6. Build new screens unique to Ophis (DCA/TWAP builder, MEV-proof receipt, dashboard) using the resulting system.
