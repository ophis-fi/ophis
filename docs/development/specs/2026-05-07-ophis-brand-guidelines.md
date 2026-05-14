# Ophis — Brand Guidelines

> **Date:** 2026-05-07
> **Owner:** Clement (san-npm)
> **Implements:** `apps/frontend/apps/cowswap-frontend/public/greg-*.svg`,
> `apps/frontend/apps/cowswap-frontend/src/greg/tokens.ts`,
> `apps/frontend/apps/cowswap-frontend/src/greg/styles.css`
> **Supersedes (in part):** `2026-05-06-ophis-brand-foundations.md` §7 mascot decision

---

## 1. Brand essence

Ophis is an **intent-based DEX aggregator**. Users express what they want; solvers compete to deliver it. The trade closes the loop: every sell finds its buyer in the same batch, MEV-protected by construction.

The brand expresses three things at once:

| Quality | How it shows up |
|---|---|
| **Cyclical** — settlement is a closed loop | The Ophie mark (ouroboros) |
| **Warm** — Ophis returns surplus to humans, not extracts it | The sunset palette (coral → magenta) |
| **Confident, dry, slightly literary** | Fraunces display + terse copy |

Ophis is **not** Web3-zany, not crypto-bro, not aggressive. The voice is closer to a senior trader who happens to like serifs.

---

## 2. Logo — "Ophie"

The Ophis mark is **an ouroboros** — a serpent eating its own tail — encircled by a beaded ring. We call it Ophie (from Greek *ophis*, serpent).

### Why the ouroboros

- **Closed loop**: a batch settlement matches sells against buys, returning the system to balance every round.
- **Beaded ring**: the rhythm of orders, blocks, slots — Ophis's chronology made visible.
- **Visible eye**: the protocol watches for surplus and returns it to the user.
- **Single line, symmetrical**: solver competition is symmetric — no arbitrage privilege.

### Variants (asset matrix)

All variants share the same path data, sourced from `ophies-logo.svg`. Each is a recolor; geometry is never modified.

| File | Fill | When to use |
|---|---|---|
| `greg-icon.svg` | coral `#E66A55` | Default favicon, mask-icon, in-app brand spots, anywhere the surface is light |
| `greg-icon-inverse.svg` | cream `#FFF3EE` | Avatars on coral, badges on dark surfaces, dark-mode favicon |
| `greg-icon-mono-dark.svg` | `#131214` | Print, low-fidelity contexts (favicons that must be solid black, sticker exports) |
| `greg-icon-sunset.svg` | sunset gradient | Hero surfaces only — landing-page splash, MEV-proof receipt artwork, Ophie-as-illustration |
| `greg-mark-app-icon.svg` | composite (coral tile + cream Ophie) | PWA maskable, Apple touch icon. The holes (eye, beads) show coral through the cream Ophie — this beadwork effect is intentional |
| `greg-wordmark.svg` | coral, Fraunces 700 | Wordmark only, when "Ophis" appears alone (header, footer line) |
| `greg-lockup.svg` | composite | Ophie + Ophis horizontal — the canonical lockup |
| `og-image.png` | composite | OG/Twitter card 1200×630 — cream Ophie on sunset radial + Fraunces wordmark + Plus Jakarta tagline + JetBrains Mono domain |

### Clear space

Around any standalone Ophie or lockup, leave at least **0.25× the icon's height** as clear space. Nothing — text, image, gradient, border — may enter that zone.

### Sizing

| Surface | Min size | Notes |
|---|---|---|
| Favicon | 16 px | Beads blur but the silhouette is recognizable. Don't go smaller |
| In-app icon | 24 px | Use the workhorse coral variant |
| App store / install | 256 px | Use `greg-mark-app-icon.svg` (maskable, has safe zone) |
| Hero / OG | 512 px+ | Use the sunset gradient variant for emotional impact |

### Don'ts

1. **Don't** rotate or mirror the mark. The bite point (head meeting tail) reads from a single orientation.
2. **Don't** strip the eye. The eye is half the personality.
3. **Don't** strip the beads. Without them the ring reads as a generic circle and we lose the rhythm.
4. **Don't** apply the sunset gradient to UI affordances (buttons, links). Gradient = hero only. Solid coral = interactive.
5. **Don't** place the cream variant on a non-Ophis-coral background — the holes/beads will show whatever's behind, which gets messy on patterned surfaces.
6. **Don't** add stroke. The mark is fill-only, single-path.

---

## 3. Color

### Brand — sunset coral (10-step)

`brand/60` `#E66A55` is the **primary action color**. Every link, button-fill, focus ring, active state derives from this anchor.

| Token | Hex | Use |
|---|---|---|
| `brand/10` | `#FFF3EE` | Hover wash, badge bg, subtle accent, *cream* — also used as inverse-logo color |
| `brand/20` | `#FFDFD3` | Subtle accent bg |
| `brand/30` | `#FFBDA8` | Decorative |
| `brand/40` | `#FF9579` | Disabled, focus ring |
| `brand/50` | `#FF7A60` | Dark-mode primary |
| `brand/60` | `#E66A55` | **Light-mode primary action** |
| `brand/70` | `#C2503D` | Primary hover, accent text |
| `brand/80` | `#993627` | Primary pressed |
| `brand/90` | `#5C1D14` | Dark-mode subtle accent bg |
| `brand/100` | `#2A0B07` | Deepest accent |

### Accent — magenta/rose (10-step)

For highlights, gradient stops, illustration. Used **sparingly** — never as a primary action.

`accent/60` `#C73D6C` is the secondary anchor.

### Functional palettes

10-step ramps for `green` (success), `yellow` (warning), `red` (danger), `blue` (info). Anchors at index 50 (light mode) and index 40 (dark mode). See `tokens.ts` for full ramps.

### Sunset gradient

```
linear-gradient(135deg, #FF8A52 0%, #FF6B5A 30%, #E55A88 65%, #A44E91 100%)
```

A radial variant is also defined for hero blocks (`gradient.sunsetRadial`).

**Rule**: gradient never touches affordances. Use it on:
- Landing-page hero block
- MEV-proof receipt artwork (the receipt itself is *the* surplus moment)
- Splash / loading screens
- Ophie hero variant
- OG / social cards

Use solid coral for buttons, links, focus rings, active tabs, anything clickable.

### Neutrals

Inherit from CoW Swap's `neutral` ramp (CoW values, not Ophis-overridden). Scale runs `neutral0` (black) → `neutral100` (white) — note inverted from Ophis's own `neutral/10..100` scale in `tokens.ts`. UI components should consume CoW neutrals via `--cow-color-neutral-*`; new Ophis-specific components consume `--greg-neutral-*` (light-to-dark).

---

## 4. Typography

Three families, all SIL Open Font License (free, commercial OK, no attribution).

### Display — Fraunces

Variable serif with an `opsz` (optical size) and a `SOFT` axis. Ophis uses `opsz: 144` and `SOFT: 50` — large display optical size with the SOFT axis dialed up gives Fraunces its warm, slightly humanist character. Pairs with the sunset palette by *temperature* — both lean warm.

Used for: Display 1, Display 2, Heading 1.

```css
font-family: 'Fraunces', ui-serif, Georgia, 'Times New Roman', serif;
font-feature-settings: 'ss01' on;
font-variation-settings: 'opsz' 144, 'SOFT' 50;
font-weight: 700;
letter-spacing: -0.02em;  /* tighten for confidence at display sizes */
```

### Body — Plus Jakarta Sans

Variable geometric humanist sans with tabular figures. Neutral but distinctive — a step up from Inter without going specialty.

Used for: Headings 2–6, body, labels, button text.

```css
font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
font-weight: 400; /* body */
font-weight: 700; /* labels, button text, sub-headings */
```

### Mono — JetBrains Mono

For addresses, transaction hashes, numeric data. Designed for code; tabular figures are non-negotiable for trade-amount readability.

```css
font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
font-variant-numeric: tabular-nums;
```

### Scale

| Token | Px | Used for |
|---|---|---|
| `xs` | 12 | Body XS, Heading 6 |
| `sm` | 14 | Body SM, Heading 5, mono |
| `md` | 16 | Body MD (default body), Heading 4, button default |
| `lg` | 18 | Body LG, Heading 3 |
| `xl` | 24 | Heading 2, button big |
| `2xl` | 32 | Heading 1 |
| `3xl` | 40 | Display 2 |
| `4xl` | 64 | Display 1 |

Line height: **120% display & heading**, **150% body**.

### Pairing rules

- Display 1/2 + H1 in **Fraunces** — only.
- Everything else (H2–H6, body, label, button, mono) in **Plus Jakarta** or **JetBrains Mono**.
- Don't pair Fraunces with Inter / system-ui — those are placeholders before Plus Jakarta loads.
- Don't pair Plus Jakarta with another sans (e.g. Inter) on the same surface — pick one body face.

### Typographic don'ts

- No all-caps display headings unless intentionally announcing. Mixed-case "Ophis" reads warmer.
- No italic in body copy at default weight (Fraunces italic is *fine* in display).
- No font-weight 900 — Fraunces 700 is already the heaviest weight Ophis ships.

---

## 5. Voice & tone

| Trait | Example | Counter-example |
|---|---|---|
| **Direct** | "I just got an extra 0.42 ETH on Ophis." | "Hey, I just earned an extra 0.42 ETH on @CoWSwap! 🐮💸" |
| **Slightly literary** | "Settlement closes the loop." | "Lightning fast crypto swaps powered by AI" |
| **Quietly confident** | "Ophis returns surplus to you when solvers find a better price than quoted." | "Get the absolute BEST price on every swap, guaranteed!!!" |
| **No emoji on UI surfaces** | Surplus reveal: "+ $3.42 over quote" | "Surplus! 🐮💸✨" |

We are not playful for the sake of being playful. The mark already does that work. Copy stays grown-up.

**Forbidden**: 🐮, "moo", "moooooo", "smoooooth", "MOO" — all CoW-lore. None of these belong on a Ophis surface.

**Encouraged**: short Latin-rooted words, em-dashes, plain numbers, no exclamation marks except in micro-celebrations.

---

## 6. Imagery & motifs

### Sunset gradient

The single most recognizable graphical element after the mark. Use it for:

- Landing-page hero
- 404 / error backgrounds (when we want emotion, not just a status code)
- MEV-proof receipt artwork
- App icon background

Never use it on affordances. Never crop it inside a button.

### Beadwork pattern

The Ophie mark's beaded ring is a **second-tier motif**. We can extract just the beads (a row of small circles, evenly spaced, in coral or cream) and use them as:

- Section dividers
- Loading-state pulse animations (each bead lights up in sequence around the ring)
- Margin ornaments on long-form pages
- Footer decorations

Do not use beads as bullet points (too noisy at small sizes).

### Photography

Ophis is currently illustration-only. If photography is added later, criteria:

- Warm, natural light — no fluorescent / blue-cast LED
- Texture-rich — wood, paper, fabric — never glossy plastic
- No people unless explicitly Ophis team / story-driven

---

## 7. Component patterns

For the full spec see `tokens.ts`, `styles.css`, and the per-component PR commits. Quick reference:

| Surface | Token | Value |
|---|---|---|
| Primary button radius | `--greg-radius-full` | 9999px (pill) |
| Card radius | `--greg-radius-lg` | 16px |
| Modal radius | (inline) | 24px (Nucleus xl half-step) |
| Swap-widget shell radius | `--greg-radius-xl` | 32px |
| MenuBar radius | `--greg-radius-xl` | 32px |
| Spacing rhythm | `--greg-space-*` | 4 / 8 / 12 / 16 / 24 / 32 / 40 / 48 / 56 / 64 / 72 / 80 |
| Stroke widths | `--greg-stroke-*` | 1 / 2 / 4 / 8 |
| Shadow elevations | `--greg-shadow-*` | low (1+1) / medium (4+8) / high (12+24) / focus (3px brand/40) |

Rules of thumb:

- **Primary buttons are always pill-shaped**.
- **Cards are radius-lg** unless they're hero (radius-xl).
- **Modal / hero / swap-widget = radius-xl**, the heaviest curve in the system.
- **Tabs are underlined coral** (no pill backgrounds for active state — keep it editorial).

---

## 8. License & assets

- **Fraunces, Plus Jakarta Sans, JetBrains Mono**: SIL Open Font License (OFL 1.1). Free for personal + commercial. No attribution required, but keep license files alongside if self-hosting the .woff2.
- **Ophie mark**: original art commissioned for Ophis (Clement, 2026-05-07). Ophis-owned IP. Don't redistribute as a generic ouroboros template.
- **Sunset gradient**: derived from Nucleus UI Lite gradient studies (`Auto Layout-2.svg`); the *concept* is generic, the specific stops are ours.
- **Tokens & token system**: scale, naming, ramp shape adapted from Nucleus UI Lite (Lite tier, free for commercial use); token *values* are Ophis-specific.

---

## 9. Open questions / next iterations

- **Animated favicon** — beads pulsing around the ring as a quote loads. Requires the existing `common/favicon/frames.ts` infrastructure to be repointed at Ophis frames. Not blocking launch.
- **Extended Ophie illustrations** — Ophie coiled differently for blog headers, illustrations of edge cases (Ophie sleeping = order pending, Ophie fed = order filled, etc.). Out of scope until launch is stable.
- **Print collateral** — business cards, swag — defer until mainnet.
- **Brand video / motion** — the beads rotating around the ring is the obvious motion lockup. Save for a launch teaser.
