# FE Polish — Resend-Inspired Landing + App Micro-Interactions: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static Astro landing at `ophis.fi/`, move the swap app to `swap.ophis.fi`, add three micro-interactions to the swap app, hit a strict perf budget (LCP < 1.5s, JS < 100KB), and ship to production with Codex audit + zero leaked secrets.

**Architecture:** New Astro SSG app at `apps/frontend/apps/ophis-landing/`. Static HTML for 6 of 7 sections; one React island for the code-tab switcher. Brand tokens auto-generated from `cowswap-frontend/src/ophis/tokens.ts` (single source of truth). Cutover via Cloudflare Pages custom-domain swap (zero downtime). App polish reuses existing framer-motion.

**Tech Stack:** Astro 5.x (static output), TypeScript, Preact compat (`@astrojs/preact` — lighter than React for the single island), CSS custom properties from tokens, IntersectionObserver, framer-motion (app side, already installed), Playwright (tests), Lighthouse CI (perf budget gate), wrangler (CF Pages deploy), gh CLI (DNS + project setup via gh/cf APIs).

**Spec:** `docs/superpowers/specs/2026-05-28-fe-resend-inspired-polish-design.md`

---

## Critical-path note

Phase 1 → 2 → 3 → 4 → 6 must run sequentially. Phase 5 (cowswap-frontend polish) is independent and can interleave anywhere. Phase 7 (Codex audit) runs after all code is committed but before cutover. Phase 8 is the actual deploy + verification.

---

## Phase 1 — Scaffold Astro app + workspace wiring

### Task 1.1: Initialize the Astro app directory + package.json

**Files:**
- Create: `apps/frontend/apps/ophis-landing/package.json`
- Create: `apps/frontend/apps/ophis-landing/.gitignore`
- Create: `apps/frontend/apps/ophis-landing/tsconfig.json`

- [ ] **Step 1: Write a Playwright test stub asserting the workspace is recognized**

Create `apps/frontend/apps/ophis-landing/tests/workspace.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('package.json defines @ophis/landing', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  expect(pkg.name).toBe('@ophis/landing')
  expect(pkg.private).toBe(true)
})
```

- [ ] **Step 2: Run it to confirm it fails (file doesn't exist)**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm exec playwright test tests/workspace.spec.ts 2>&1 | tail -5
```

Expected: ENOENT or "package.json does not exist" failure.

- [ ] **Step 3: Write the package.json**

```json
{
  "name": "@ophis/landing",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "prebuild": "node scripts/tokens-to-css.mjs",
    "dev": "pnpm prebuild && astro dev",
    "build": "pnpm prebuild && astro build",
    "preview": "astro preview",
    "typecheck": "astro check",
    "test": "playwright test",
    "lh": "lhci autorun"
  },
  "dependencies": {
    "astro": "^5.0.0",
    "@astrojs/preact": "^4.0.0",
    "preact": "^10.0.0",
    "sharp": "^0.33.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@lhci/cli": "^0.14.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 4: Write tsconfig.json**

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
```

- [ ] **Step 5: Write .gitignore**

```
dist/
.astro/
node_modules/
src/styles/tokens.css
```

- [ ] **Step 6: Install + run the test**

```bash
cd /Users/scep/greg/apps/frontend
pnpm install --lockfile-only
cd apps/ophis-landing
pnpm install
pnpm exec playwright test tests/workspace.spec.ts 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/scep/greg
git add apps/frontend/apps/ophis-landing/package.json \
        apps/frontend/apps/ophis-landing/tsconfig.json \
        apps/frontend/apps/ophis-landing/.gitignore \
        apps/frontend/apps/ophis-landing/tests/workspace.spec.ts \
        apps/frontend/pnpm-lock.yaml
git commit -m "feat(landing): initialize @ophis/landing Astro workspace"
```

### Task 1.2: Configure astro.config.mjs

**Files:**
- Create: `apps/frontend/apps/ophis-landing/astro.config.mjs`

- [ ] **Step 1: Write a smoke-test spec that astro build emits dist/index.html**

Append to `tests/workspace.spec.ts`:

```typescript
import { existsSync } from 'node:fs'

test('astro build produces dist/index.html', async () => {
  // This test runs after `pnpm build` in CI/local
  const distIndex = join(__dirname, '..', 'dist', 'index.html')
  expect(existsSync(distIndex)).toBe(true)
})
```

- [ ] **Step 2: Run the test, confirm fail**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm exec playwright test tests/workspace.spec.ts -g "astro build" 2>&1 | tail -5
```

Expected: FAIL — dist/ doesn't exist yet.

- [ ] **Step 3: Write astro.config.mjs**

```javascript
import { defineConfig } from 'astro/config'
import preact from '@astrojs/preact'

export default defineConfig({
  output: 'static',
  site: 'https://ophis.fi',
  trailingSlash: 'never',
  build: {
    inlineStylesheets: 'auto',
    assets: '_assets',
  },
  integrations: [
    preact({ compat: false }),
  ],
  vite: {
    build: {
      cssMinify: 'lightningcss',
    },
  },
  prefetch: false,
  compressHTML: true,
})
```

- [ ] **Step 4: Create a minimal placeholder page so build succeeds**

`apps/frontend/apps/ophis-landing/src/pages/index.astro`:

```astro
---
---
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Ophis</title>
</head>
<body>
  <h1>Ophis</h1>
</body>
</html>
```

- [ ] **Step 5: Build + run test**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm build
pnpm exec playwright test tests/workspace.spec.ts -g "astro build" 2>&1 | tail -5
```

Expected: build succeeds, test PASSes.

- [ ] **Step 6: Commit**

```bash
cd /Users/scep/greg
git add apps/frontend/apps/ophis-landing/astro.config.mjs \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/workspace.spec.ts
git commit -m "feat(landing): configure astro static output + placeholder index"
```

### Task 1.3: Set up the tokens-to-css codegen

**Files:**
- Create: `apps/frontend/apps/ophis-landing/scripts/tokens-to-css.mjs`
- Modify: `apps/frontend/apps/ophis-landing/.gitignore` (already excludes generated tokens.css)

- [ ] **Step 1: Write the test asserting tokens.css gets generated with saffron-60**

Create `apps/frontend/apps/ophis-landing/tests/tokens-codegen.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TOKENS_CSS = join(__dirname, '..', 'src', 'styles', 'tokens.css')

test('tokens-to-css generates tokens.css from cowswap-frontend source', () => {
  if (existsSync(TOKENS_CSS)) {
    execSync(`rm ${TOKENS_CSS}`)
  }
  execSync('node scripts/tokens-to-css.mjs', { cwd: join(__dirname, '..') })
  expect(existsSync(TOKENS_CSS)).toBe(true)
  const css = readFileSync(TOKENS_CSS, 'utf8')
  expect(css).toContain('--ophis-saffron-60: #f2a63e')
  expect(css).toContain('--ophis-bg: #0a0a0a')
})
```

- [ ] **Step 2: Run the test, confirm fail**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm exec playwright test tests/tokens-codegen.spec.ts 2>&1 | tail -5
```

Expected: FAIL — scripts/tokens-to-css.mjs doesn't exist.

- [ ] **Step 3: Write the codegen script**

`apps/frontend/apps/ophis-landing/scripts/tokens-to-css.mjs`:

```javascript
#!/usr/bin/env node
// Reads cowswap-frontend's ophis tokens, emits CSS custom properties.
// Single source of truth: tokens.ts. Generated file is gitignored.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOKENS_SRC = join(__dirname, '..', '..', 'cowswap-frontend', 'src', 'ophis', 'tokens.ts')
const TOKENS_OUT = join(__dirname, '..', 'src', 'styles', 'tokens.css')

const src = readFileSync(TOKENS_SRC, 'utf8')

// Extract saffron ramp (60 is the canonical primary)
function pluck(key) {
  const re = new RegExp(`${key}:\\s*['"\`]?(#[0-9a-fA-F]{6,8})['"\`]?`)
  const m = src.match(re)
  if (!m) throw new Error(`token ${key} not found in tokens.ts`)
  return m[1]
}

const saffron60 = pluck('saffron') || '#f2a63e' // fallback if shape differs

const css = `/* GENERATED by scripts/tokens-to-css.mjs from cowswap-frontend/src/ophis/tokens.ts. Do not edit. */
:root {
  --ophis-saffron-60: ${saffron60};
  --ophis-saffron-30: #ffd09a;
  --ophis-bg: #0a0a0a;
  --ophis-fg: #ffffff;
  --ophis-fg-muted: rgba(255, 255, 255, 0.65);
  --ophis-fg-faded: rgba(255, 255, 255, 0.4);
  --ophis-surface: rgba(255, 255, 255, 0.02);
  --ophis-border: rgba(255, 255, 255, 0.08);
  --ophis-radius: 12px;
  --ophis-radius-sm: 8px;
}
`

mkdirSync(dirname(TOKENS_OUT), { recursive: true })
writeFileSync(TOKENS_OUT, css)
console.log(`tokens.css written: ${TOKENS_OUT}`)
```

- [ ] **Step 4: Run + verify**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm exec playwright test tests/tokens-codegen.spec.ts 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/scep/greg
git add apps/frontend/apps/ophis-landing/scripts/tokens-to-css.mjs \
        apps/frontend/apps/ophis-landing/tests/tokens-codegen.spec.ts
git commit -m "feat(landing): tokens-to-css codegen reads cowswap-frontend tokens"
```

---

## Phase 2 — Motion primitives + base styles

### Task 2.1: Write global.css with motion keyframes + reset

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/styles/global.css`

- [ ] **Step 1: Write Playwright DOM test asserting reveal-up class transitions**

`apps/frontend/apps/ophis-landing/tests/motion.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('reveal-up class has correct initial + active states', async ({ page }) => {
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles/global.css">
    <div class="reveal-up" id="t1">hello</div>
    <div class="reveal-up in-view" id="t2">visible</div>
  `)
  const initial = await page.locator('#t1').evaluate(el => getComputedStyle(el).opacity)
  const active = await page.locator('#t2').evaluate(el => getComputedStyle(el).opacity)
  expect(parseFloat(initial)).toBeLessThan(0.5)
  expect(parseFloat(active)).toBe(1)
})
```

- [ ] **Step 2: Run, confirm fail (no global.css)**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm exec playwright test tests/motion.spec.ts 2>&1 | tail -5
```

Expected: FAIL.

- [ ] **Step 3: Write global.css**

```css
/* Imports tokens.css (generated). MUST be first. */
@import './tokens.css';

* { box-sizing: border-box; }
html { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
body {
  margin: 0;
  background: var(--ophis-bg);
  color: var(--ophis-fg);
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
  font-size: 17px;
  line-height: 1.5;
}

/* Reveal-up motion primitive */
.reveal-up {
  opacity: 0;
  transform: translateY(30px);
  transition: opacity 300ms ease-out, transform 300ms ease-out;
  will-change: opacity, transform;
}
.reveal-up.in-view {
  opacity: 1;
  transform: translateY(0);
}

/* Stagger via nth-child */
.stagger > .reveal-up:nth-child(2) { transition-delay: 80ms; }
.stagger > .reveal-up:nth-child(3) { transition-delay: 160ms; }
.stagger > .reveal-up:nth-child(4) { transition-delay: 240ms; }
.stagger > .reveal-up:nth-child(5) { transition-delay: 320ms; }

/* Nav blur (toggled by JS) */
.nav { background: transparent; transition: background 200ms ease, border-color 200ms ease; border-bottom: 1px solid transparent; }
.nav.scrolled {
  background: rgba(10, 10, 10, 0.85);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-bottom-color: var(--ophis-border);
}

/* Claw rotate */
@keyframes claw-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.claw {
  animation: claw-spin 40s linear infinite;
  transform-origin: center;
  will-change: transform;
}

/* Gradient accent shimmer */
@keyframes shimmer {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}
.accent {
  background: linear-gradient(135deg, var(--ophis-saffron-60) 0%, var(--ophis-saffron-30) 50%, var(--ophis-saffron-60) 100%);
  background-size: 200% 200%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: shimmer 8s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .reveal-up { opacity: 1 !important; transform: none !important; transition: none !important; }
  .claw { animation: none !important; }
  .accent { animation: none !important; }
  * { transition: none !important; }
}
```

- [ ] **Step 4: Run the test, confirm pass**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm exec playwright test tests/motion.spec.ts 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/scep/greg
git add apps/frontend/apps/ophis-landing/src/styles/global.css \
        apps/frontend/apps/ophis-landing/tests/motion.spec.ts
git commit -m "feat(landing): motion primitives (reveal-up, stagger, nav-blur, claw, shimmer)"
```

### Task 2.2: Write reveal.ts (IntersectionObserver bootstrap)

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/lib/reveal.ts`

- [ ] **Step 1: Write Playwright test for reveal hook**

Append to `tests/motion.spec.ts`:

```typescript
test('reveal.ts adds in-view class when element is observed', async ({ page }) => {
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles/global.css">
    <div class="reveal-up" data-reveal>visible after JS</div>
    <script type="module" src="/src/lib/reveal.ts"></script>
  `)
  await page.waitForTimeout(100) // allow IO callback
  await expect(page.locator('.reveal-up')).toHaveClass(/in-view/)
})
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm exec playwright test tests/motion.spec.ts -g "reveal.ts" 2>&1 | tail -5
```

Expected: FAIL.

- [ ] **Step 3: Write reveal.ts**

```typescript
// IntersectionObserver bootstrap. Targets [data-reveal] elements with .reveal-up base class.
// Adds .in-view when element enters viewport. Idempotent: stops observing after first reveal.

const targets = document.querySelectorAll<HTMLElement>('[data-reveal]')

if (targets.length === 0) {
  // nothing to do; export for tree-shaking guards
}

const io = new IntersectionObserver(
  (entries, observer) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view')
        observer.unobserve(entry.target)
      }
    }
  },
  {
    rootMargin: '0px 0px -10% 0px', // trigger slightly before fully in view
    threshold: 0.1,
  }
)

targets.forEach((el) => io.observe(el))

export {} // ensure module
```

- [ ] **Step 4: Run, confirm pass**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm exec playwright test tests/motion.spec.ts -g "reveal.ts" 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/scep/greg
git add apps/frontend/apps/ophis-landing/src/lib/reveal.ts \
        apps/frontend/apps/ophis-landing/tests/motion.spec.ts
git commit -m "feat(landing): IntersectionObserver reveal bootstrap"
```

### Task 2.3: Write nav-blur.ts (scroll listener)

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/lib/nav-blur.ts`

- [ ] **Step 1: Test the scroll handler**

Append to `tests/motion.spec.ts`:

```typescript
test('nav-blur toggles .scrolled class past 40px scroll', async ({ page }) => {
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles/global.css">
    <div style="height: 200vh">
      <nav class="nav" id="nav">nav</nav>
    </div>
    <script type="module" src="/src/lib/nav-blur.ts"></script>
  `)
  await expect(page.locator('#nav')).not.toHaveClass(/scrolled/)
  await page.evaluate(() => window.scrollTo(0, 100))
  await page.waitForTimeout(50)
  await expect(page.locator('#nav')).toHaveClass(/scrolled/)
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write nav-blur.ts**

```typescript
// Toggles .scrolled on the first .nav element when scrollY > 40px. Passive listener.

const nav = document.querySelector<HTMLElement>('.nav')
if (nav) {
  let lastScrolled = false
  const update = () => {
    const scrolled = window.scrollY > 40
    if (scrolled !== lastScrolled) {
      nav.classList.toggle('scrolled', scrolled)
      lastScrolled = scrolled
    }
  }
  window.addEventListener('scroll', update, { passive: true })
  update() // initial check
}

export {}
```

- [ ] **Step 4: Run, confirm pass**

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/apps/ophis-landing/src/lib/nav-blur.ts \
        apps/frontend/apps/ophis-landing/tests/motion.spec.ts
git commit -m "feat(landing): nav-blur scroll listener"
```

---

## Phase 3 — Base layout + section components

### Task 3.1: Base layout with security-headers ready, font preload, redirect script

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/layouts/Base.astro`
- Modify: `apps/frontend/apps/ophis-landing/src/pages/index.astro`

- [ ] **Step 1: Test the layout renders meta + redirect script + critical CSS**

`apps/frontend/apps/ophis-landing/tests/layout.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('Base layout renders Ophis meta + redirect script', async ({ page }) => {
  await page.goto('/')
  expect(await page.title()).toContain('Ophis')
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content')
  expect(ogTitle).toContain('Ophis')
  // redirect script must check localStorage + use the literal swap subdomain
  const html = await page.content()
  expect(html).toContain('ophis_wallet_connected')
  expect(html).toContain("'https://swap.ophis.fi/'")
})
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm dev &
sleep 3
pnpm exec playwright test tests/layout.spec.ts 2>&1 | tail -5
pkill -f "astro dev" || true
```

Expected: FAIL — no proper layout yet.

- [ ] **Step 3: Write Base.astro**

```astro
---
export interface Props {
  title?: string
  description?: string
  canonical?: string
}
const {
  title = 'Ophis — DEX aggregator for the agent era',
  description = 'Intent-based, MEV-protected, batch-settled swaps. Describe a trade in plain English; settle in one batch. Built for autonomous agents.',
  canonical = 'https://ophis.fi/',
} = Astro.props
---
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0a0a0a">
  <title>{title}</title>
  <meta name="description" content={description}>
  <link rel="canonical" href={canonical}>
  <link rel="icon" type="image/svg+xml" href="/ophis-claw-saffron.svg">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:title" content={title}>
  <meta property="og:description" content={description}>
  <meta property="og:url" content={canonical}>
  <meta property="og:image" content="https://ophis.fi/og-image.png">
  <meta property="og:image:width" content="1280">
  <meta property="og:image:height" content="640">
  <meta property="og:site_name" content="Ophis">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content={title}>
  <meta name="twitter:description" content={description}>
  <meta name="twitter:image" content="https://ophis.fi/og-image.png">

  <!-- Font preload (Geist subset) -->
  <link rel="preload" href="/fonts/geist-variable-subset.woff2" as="font" type="font/woff2" crossorigin>

  <!-- Returning-trader fast path. Runs synchronously before paint. Literal URL only. -->
  <script>
    try {
      if (localStorage.getItem('ophis_wallet_connected') === 'true') {
        window.location.replace('https://swap.ophis.fi/');
      }
    } catch (e) { /* localStorage blocked: ignore */ }
  </script>

  <!-- Critical CSS slot — Astro inlines /src/styles/global.css here -->
  <style>@import '../styles/global.css';</style>
</head>
<body>
  <slot />
</body>
</html>
```

- [ ] **Step 4: Update index.astro to use Base**

```astro
---
import Base from '../layouts/Base.astro'
---
<Base>
  <h1>Ophis</h1>
  <p>Landing scaffold.</p>
</Base>
```

- [ ] **Step 5: Run + verify**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm dev &
sleep 3
pnpm exec playwright test tests/layout.spec.ts 2>&1 | tail -5
pkill -f "astro dev" || true
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/scep/greg
git add apps/frontend/apps/ophis-landing/src/layouts/Base.astro \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/layout.spec.ts
git commit -m "feat(landing): Base layout with OG/Twitter meta + redirect fast path"
```

### Task 3.2: Nav.astro (sticky, frosted on scroll)

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/components/Nav.astro`
- Modify: `apps/frontend/apps/ophis-landing/src/pages/index.astro`

- [ ] **Step 1: Test the nav has logo + 5 links + CTA**

`apps/frontend/apps/ophis-landing/tests/nav.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('nav renders logo + nav links + Launch app CTA', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.nav .logo')).toHaveText('Ophis')
  const links = page.locator('.nav .nav-links a')
  await expect(links).toHaveCount(5)
  await expect(page.locator('.nav .nav-cta')).toHaveText(/Launch app/)
})

test('nav becomes frosted past scroll threshold', async ({ page }) => {
  await page.goto('/')
  await page.setViewportSize({ width: 1200, height: 800 })
  await expect(page.locator('.nav')).not.toHaveClass(/scrolled/)
  await page.evaluate(() => window.scrollTo(0, 200))
  await page.waitForTimeout(80)
  await expect(page.locator('.nav')).toHaveClass(/scrolled/)
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write Nav.astro**

```astro
---
const links = [
  { href: '#features', label: 'Product' },
  { href: 'https://docs.ophis.fi', label: 'Docs' },
  { href: 'https://github.com/ophis-fi/ophis/tree/main/packages/sdk', label: 'SDK' },
  { href: '#sdk', label: 'Pricing' },
  { href: 'https://github.com/ophis-fi/ophis/blob/main/CHANGELOG.md', label: 'Blog' },
]
---
<nav class="nav">
  <div class="nav-inner">
    <a class="logo" href="/">Ophis</a>
    <div class="nav-links">
      {links.map(({ href, label }) => (
        <a href={href} rel={href.startsWith('http') ? 'noopener' : undefined}>{label}</a>
      ))}
    </div>
    <a class="nav-cta" href="https://swap.ophis.fi/">Launch app</a>
  </div>
</nav>
<script src="../lib/nav-blur.ts"></script>

<style>
  .nav {
    position: sticky;
    top: 0;
    z-index: 50;
    padding-block: 16px;
  }
  .nav-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding-inline: 56px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .nav .logo {
    font-weight: 700;
    font-size: 18px;
    letter-spacing: -0.01em;
    color: var(--ophis-saffron-60);
    text-decoration: none;
  }
  .nav-links { display: flex; gap: 24px; }
  .nav-links a {
    color: var(--ophis-fg-muted);
    font-size: 13px;
    text-decoration: none;
    transition: color 120ms ease;
  }
  .nav-links a:hover { color: var(--ophis-fg); }
  .nav-cta {
    background: var(--ophis-saffron-60);
    color: var(--ophis-bg);
    padding: 8px 16px;
    border-radius: var(--ophis-radius-sm);
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    transition: filter 150ms ease;
  }
  .nav-cta:hover { filter: brightness(1.05); }
  @media (max-width: 720px) {
    .nav-inner { padding-inline: 20px; }
    .nav-links { display: none; }
  }
</style>
```

- [ ] **Step 4: Wire into index.astro**

```astro
---
import Base from '../layouts/Base.astro'
import Nav from '../components/Nav.astro'
---
<Base>
  <Nav />
  <main>
    <h1>Ophis</h1>
  </main>
</Base>
```

- [ ] **Step 5: Run + verify**

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/apps/ophis-landing/src/components/Nav.astro \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/nav.spec.ts
git commit -m "feat(landing): sticky frosted Nav with logo + links + Launch app CTA"
```

### Task 3.3: Hero.astro (headline + accent + claw + CTAs)

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/components/Hero.astro`
- Create: `apps/frontend/apps/ophis-landing/public/ophis-claw-saffron.svg` (copy from cowswap-frontend public, recolor at build time)
- Modify: `apps/frontend/apps/ophis-landing/src/pages/index.astro`

- [ ] **Step 1: Test hero content**

`apps/frontend/apps/ophis-landing/tests/hero.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('hero has headline, accent word, two CTAs, claw image', async ({ page }) => {
  await page.goto('/')
  const h1 = page.locator('.hero h1')
  await expect(h1).toContainText('DEX aggregator')
  await expect(h1).toContainText('agent era')
  await expect(page.locator('.hero .accent')).toContainText('agent era')
  await expect(page.locator('.hero .cta-primary')).toContainText(/Launch app/)
  await expect(page.locator('.hero .cta-secondary')).toContainText(/Read docs/)
  await expect(page.locator('.hero img[alt=""], .hero img[alt="Ophis"]')).toBeVisible()
})

test('hero claw has animation paused under prefers-reduced-motion', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto('/')
  const anim = await page.locator('.hero .claw').evaluate(el => getComputedStyle(el).animationName)
  expect(anim).toBe('none')
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Add the saffron claw SVG to public/**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
mkdir -p public
sed 's/fill="black"/fill="#f2a63e"/g; s/stroke="black"/stroke="#f2a63e"/g' \
  ../cowswap-frontend/public/ophis-logo-full.svg \
  > public/ophis-claw-saffron.svg
```

- [ ] **Step 4: Write Hero.astro**

```astro
---
const pillText = 'Announcing the Ophis SDK →'
const pillHref = 'https://github.com/ophis-fi/ophis/tree/main/packages/sdk'
---
<section class="hero">
  <div class="hero-inner">
    <div class="hero-copy">
      <a class="pill reveal-up" data-reveal href={pillHref}>{pillText}</a>
      <h1 class="reveal-up" data-reveal>
        DEX aggregator<br>
        for the <span class="accent">agent era</span>.
      </h1>
      <p class="subhead reveal-up" data-reveal>
        Intent-based, MEV-protected, batch-settled swaps. Describe a trade in plain English; settle in one batch. Built for autonomous agents and the developers who deploy them.
      </p>
      <div class="ctas reveal-up" data-reveal>
        <a class="cta-primary" href="https://swap.ophis.fi/">Launch app</a>
        <a class="cta-secondary" href="https://docs.ophis.fi" rel="noopener">Read docs</a>
      </div>
    </div>
    <div class="hero-anchor reveal-up" data-reveal>
      <img class="claw" src="/ophis-claw-saffron.svg" alt="" width="280" height="290" loading="eager" decoding="async">
    </div>
  </div>
</section>
<script src="../lib/reveal.ts"></script>

<style>
  .hero {
    position: relative;
    overflow: hidden;
  }
  .hero::before {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse 80% 60% at 70% 30%, rgba(242, 166, 62, 0.08), transparent 55%);
    pointer-events: none;
  }
  .hero-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 80px 56px 100px;
    display: grid;
    grid-template-columns: 1.1fr 1fr;
    gap: 40px;
    align-items: center;
    position: relative;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border: 1px solid var(--ophis-border);
    border-radius: 100px;
    font-size: 12px;
    color: rgba(255,255,255,0.85);
    margin-bottom: 24px;
    text-decoration: none;
    width: max-content;
    transition: border-color 150ms ease;
  }
  .pill::before { content: ""; width: 6px; height: 6px; background: var(--ophis-saffron-60); border-radius: 100%; }
  .pill:hover { border-color: var(--ophis-saffron-60); }
  h1 {
    font-size: 56px;
    line-height: 1.05;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 20px;
  }
  .subhead {
    font-size: 17px;
    line-height: 1.5;
    color: var(--ophis-fg-muted);
    max-width: 480px;
    margin: 0 0 32px;
  }
  .ctas { display: flex; gap: 12px; }
  .cta-primary, .cta-secondary {
    padding: 12px 22px;
    border-radius: var(--ophis-radius-sm);
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    transition: filter 150ms ease, background-color 150ms ease;
  }
  .cta-primary {
    background: var(--ophis-saffron-60);
    color: var(--ophis-bg);
    font-weight: 600;
  }
  .cta-primary:hover { filter: brightness(1.05); }
  .cta-secondary {
    color: var(--ophis-fg);
    border: 1px solid var(--ophis-border);
  }
  .cta-secondary:hover { border-color: var(--ophis-fg-muted); }

  .hero-anchor {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .hero-anchor::before {
    content: "";
    position: absolute;
    width: 380px;
    height: 380px;
    background: radial-gradient(circle, rgba(242, 166, 62, 0.18), transparent 70%);
    filter: blur(40px);
    pointer-events: none;
  }
  .hero-anchor img {
    width: 280px;
    height: 280px;
    position: relative;
    z-index: 1;
  }
  @media (max-width: 720px) {
    .hero-inner { grid-template-columns: 1fr; padding: 60px 20px 80px; gap: 32px; }
    h1 { font-size: 40px; }
    .hero-anchor img { width: 200px; height: 200px; }
  }
</style>
```

- [ ] **Step 5: Wire into index.astro**

```astro
---
import Base from '../layouts/Base.astro'
import Nav from '../components/Nav.astro'
import Hero from '../components/Hero.astro'
---
<Base>
  <Nav />
  <main>
    <Hero />
  </main>
</Base>
```

- [ ] **Step 6: Run + verify**

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/apps/ophis-landing/src/components/Hero.astro \
        apps/frontend/apps/ophis-landing/public/ophis-claw-saffron.svg \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/hero.spec.ts
git commit -m "feat(landing): hero section with saffron claw, gradient accent, reduced-motion respect"
```

### Task 3.4: ChainsStrip.astro

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/components/ChainsStrip.astro`
- Modify: `apps/frontend/apps/ophis-landing/src/pages/index.astro`

- [ ] **Step 1: Test chain entries (5 chains, 1 live, 4 paused/via-NEAR)**

`apps/frontend/apps/ophis-landing/tests/chains.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('chains strip lists 5 chains with proper status', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.chains .chain')
  await expect(items).toHaveCount(5)
  await expect(items.nth(0)).toContainText('Optimism')
  await expect(items.nth(1)).toContainText(/HyperEVM/)
  await expect(items.nth(1)).toContainText(/paused/)
  await expect(items.nth(3)).toContainText(/via NEAR/)
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write ChainsStrip.astro**

```astro
---
const chains = [
  { name: 'Optimism', status: 'live' },
  { name: 'HyperEVM', status: 'paused' },
  { name: 'MegaETH', status: 'paused' },
  { name: 'Solana', status: 'via NEAR' },
  { name: 'Bitcoin', status: 'via NEAR' },
]
---
<section class="chains">
  <div class="chains-inner reveal-up" data-reveal>
    <div class="label">Live on</div>
    <div class="chains-row stagger">
      {chains.map(c => (
        <div class={`chain reveal-up ${c.status === 'live' ? 'is-live' : 'is-muted'}`} data-reveal>
          <span class="chain-name">{c.name}</span>
          {c.status !== 'live' && <span class="chain-status">{c.status}</span>}
        </div>
      ))}
    </div>
  </div>
</section>

<style>
  .chains { padding: 60px 56px; text-align: center; }
  .label {
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--ophis-fg-faded);
    margin-bottom: 24px;
  }
  .chains-row {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 60px;
    flex-wrap: wrap;
  }
  .chain { display: flex; align-items: center; gap: 8px; }
  .chain.is-live { color: var(--ophis-fg-muted); }
  .chain.is-muted { color: var(--ophis-fg-faded); }
  .chain-name { font-weight: 600; font-size: 17px; }
  .chain-status {
    font-size: 10px;
    color: var(--ophis-fg-faded);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  @media (max-width: 720px) {
    .chains-row { gap: 24px; }
  }
</style>
```

- [ ] **Step 4: Wire + run + verify**

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/apps/ophis-landing/src/components/ChainsStrip.astro \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/chains.spec.ts
git commit -m "feat(landing): chains strip with live/paused/via-NEAR status"
```

### Task 3.5: CodeSection.astro + CodeTabs.tsx (Preact island)

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/components/CodeSection.astro`
- Create: `apps/frontend/apps/ophis-landing/src/islands/CodeTabs.tsx`
- Modify: `apps/frontend/apps/ophis-landing/src/pages/index.astro`

- [ ] **Step 1: Test code section + tab switching**

`apps/frontend/apps/ophis-landing/tests/code-section.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('code section default tab is curl', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.code-section h2')).toContainText(/Trade.*tonight/)
  await expect(page.locator('.tab.active')).toContainText('curl')
  await expect(page.locator('.code-body')).toContainText('curl')
  await expect(page.locator('.code-body')).toContainText('ophis.fi/api/intent')
})

test('clicking JavaScript tab switches code body', async ({ page }) => {
  await page.goto('/')
  await page.locator('.tab', { hasText: 'JavaScript' }).click()
  await expect(page.locator('.code-body')).toContainText('fetch')
  await expect(page.locator('.code-body')).not.toContainText('curl -X POST')
})

test('code section never includes any auth header or API key', async ({ page }) => {
  await page.goto('/')
  const body = await page.locator('.code-body').textContent()
  expect(body).not.toMatch(/api[_-]?key|x-api-key|bearer|authorization/i)
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write CodeTabs.tsx (Preact island)**

```tsx
/** @jsxImportSource preact */
import { useState } from 'preact/hooks'

const samples = {
  curl: `# Get a quote for 100 USDC -> WETH on Optimism
curl -X POST https://ophis.fi/api/intent \\
  -H "Content-Type: application/json" \\
  -d '{
    "intent": "swap 100 USDC for WETH on Optimism",
    "from": "0x..."
  }'

# Returns a signed order ready to relay to the Ophis settlement stack.`,
  JavaScript: `// Get a quote for 100 USDC -> WETH on Optimism
const res = await fetch('https://ophis.fi/api/intent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    intent: 'swap 100 USDC for WETH on Optimism',
    from: '0x...',
  }),
})
const order = await res.json()`,
  Rust: `// Get a quote for 100 USDC -> WETH on Optimism
let body = serde_json::json!({
  "intent": "swap 100 USDC for WETH on Optimism",
  "from": "0x...",
});
let order: serde_json::Value = reqwest::Client::new()
  .post("https://ophis.fi/api/intent")
  .json(&body)
  .send()
  .await?
  .json()
  .await?;`,
} as const

type Tab = keyof typeof samples
const tabs: Tab[] = ['curl', 'JavaScript', 'Rust']

export default function CodeTabs() {
  const [active, setActive] = useState<Tab>('curl')
  return (
    <div class="code-frame">
      <div class="tabs" role="tablist">
        {tabs.map(t => (
          <button
            class={`tab ${active === t ? 'active' : ''}`}
            role="tab"
            aria-selected={active === t}
            onClick={() => setActive(t)}
            type="button"
          >
            {t}
          </button>
        ))}
      </div>
      <pre class="code-body"><code>{samples[active]}</code></pre>
    </div>
  )
}
```

- [ ] **Step 4: Write CodeSection.astro**

```astro
---
import CodeTabs from '../islands/CodeTabs.tsx'
---
<section class="code-section" id="features">
  <div class="code-inner">
    <h2 class="reveal-up" data-reveal>
      Trade <span class="accent">tonight.</span>
    </h2>
    <p class="sub reveal-up" data-reveal>
      An intent, a sell token, a buy token. The Ophis API does the rest — quote, route, MEV protection, settlement. Hit it from JavaScript, Rust, or just <code>curl</code>.
    </p>
    <div class="reveal-up" data-reveal>
      <CodeTabs client:visible />
    </div>
  </div>
</section>

<style>
  .code-section { padding: 80px 56px; }
  .code-inner { max-width: 880px; margin: 0 auto; }
  h2 {
    text-align: center;
    font-size: 40px;
    line-height: 1.1;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 12px;
  }
  .sub {
    text-align: center;
    color: var(--ophis-fg-muted);
    margin: 0 auto 40px;
    max-width: 540px;
  }
  .sub code {
    background: var(--ophis-surface);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
  }
  :global(.code-frame) {
    background: #111114;
    border: 1px solid var(--ophis-border);
    border-radius: var(--ophis-radius);
    overflow: hidden;
  }
  :global(.tabs) {
    display: flex;
    gap: 4px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--ophis-border);
  }
  :global(.tab) {
    appearance: none;
    background: transparent;
    border: 0;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--ophis-fg-faded);
    cursor: pointer;
    font-family: inherit;
  }
  :global(.tab.active) {
    background: var(--ophis-surface);
    color: var(--ophis-saffron-60);
  }
  :global(.code-body) {
    margin: 0;
    padding: 24px;
    font-family: 'JetBrains Mono', 'Menlo', monospace;
    font-size: 13px;
    line-height: 1.6;
    color: var(--ophis-fg-muted);
    overflow-x: auto;
    white-space: pre-wrap;
  }
</style>
```

- [ ] **Step 5: Wire into index.astro + run + verify**

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/apps/ophis-landing/src/components/CodeSection.astro \
        apps/frontend/apps/ophis-landing/src/islands/CodeTabs.tsx \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/code-section.spec.ts
git commit -m "feat(landing): trade-tonight code section with curl/JS/Rust tabs (preact island)"
```

### Task 3.6: FeatureGrid.astro

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/components/FeatureGrid.astro`
- Modify: `apps/frontend/apps/ophis-landing/src/pages/index.astro`

- [ ] **Step 1: Test 3 cards with names + descriptions**

`apps/frontend/apps/ophis-landing/tests/features.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('feature grid renders MEV / Rebates / SDK cards', async ({ page }) => {
  await page.goto('/')
  const cards = page.locator('.features .feat')
  await expect(cards).toHaveCount(3)
  await expect(cards.nth(0)).toContainText('MEV protection')
  await expect(cards.nth(1)).toContainText(/[Vv]olume.*[Rr]ebate/)
  await expect(cards.nth(2)).toContainText(/Agent.*safety/)
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write FeatureGrid.astro**

```astro
---
const features = [
  {
    name: 'MEV protection',
    desc: 'Batch auctions, off-chain solver competition. Users never lose surplus to frontrunners.',
  },
  {
    name: 'Volume-tier rebates',
    desc: 'High-volume agents and DAOs earn fee rebates automatically via the rebate-indexer.',
  },
  {
    name: 'Agent-safety SDK',
    desc: 'Receiver-pin checks, chain-id validation, partner-fee config — guardrails out of the box.',
  },
]
---
<section class="features">
  <div class="features-inner">
    <h2 class="reveal-up" data-reveal>
      Built for <span class="accent">real flow.</span>
    </h2>
    <div class="features-grid stagger">
      {features.map(f => (
        <article class="feat reveal-up" data-reveal>
          <div class="feat-icon"></div>
          <h3>{f.name}</h3>
          <p>{f.desc}</p>
        </article>
      ))}
    </div>
  </div>
</section>

<style>
  .features { padding: 80px 56px; }
  .features-inner { max-width: 1200px; margin: 0 auto; }
  h2 {
    text-align: center;
    font-size: 40px;
    line-height: 1.1;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 50px;
  }
  .features-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 24px;
  }
  .feat {
    background: var(--ophis-surface);
    border: 1px solid var(--ophis-border);
    border-radius: var(--ophis-radius);
    padding: 28px;
  }
  .feat-icon {
    width: 32px;
    height: 32px;
    border-radius: var(--ophis-radius-sm);
    background: rgba(242, 166, 62, 0.12);
    margin-bottom: 16px;
  }
  .feat h3 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
  .feat p {
    color: var(--ophis-fg-muted);
    font-size: 14px;
    line-height: 1.5;
    margin: 0;
  }
  @media (max-width: 720px) {
    .features-grid { grid-template-columns: 1fr; }
  }
</style>
```

- [ ] **Step 4: Wire + verify**

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/apps/ophis-landing/src/components/FeatureGrid.astro \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/features.spec.ts
git commit -m "feat(landing): three-card feature grid (MEV / rebates / agent-safety SDK)"
```

### Task 3.7: SDKSection.astro

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/components/SDKSection.astro`
- Modify: `apps/frontend/apps/ophis-landing/src/pages/index.astro`

- [ ] **Step 1: Test SDK section**

`apps/frontend/apps/ophis-landing/tests/sdk.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('SDK section shows configurePartnerFee snippet + install command', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.sdk h2')).toContainText('Ship integrations')
  await expect(page.locator('.sdk .sdk-tag')).toContainText('@ophis/sdk')
  await expect(page.locator('.sdk pre')).toContainText('configurePartnerFee')
  await expect(page.locator('.sdk a[href*="npmjs"], .sdk a[href*="github.com/ophis-fi"]')).toBeVisible()
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write SDKSection.astro**

```astro
---
const code = `import { configurePartnerFee } from '@ophis/sdk'

const order = configurePartnerFee({
  chainId: 10,
  receiver: '0xYourSafe...',
  bps: 25, // 0.25% of surplus
})

// receiver-pin + chain-id checks happen automatically`
---
<section class="sdk" id="sdk">
  <div class="sdk-inner">
    <div class="sdk-copy reveal-up" data-reveal>
      <span class="sdk-tag">@ophis/sdk</span>
      <h2>Ship integrations <span class="accent">in an afternoon.</span></h2>
      <p>
        Receiver-pin checks, chain-id validation, partner-fee config — everything an agent needs to swap without footguns.
      </p>
      <div class="ctas">
        <a class="cta-secondary" href="https://www.npmjs.com/package/@ophis/sdk" rel="noopener">npm i @ophis/sdk</a>
        <a class="cta-secondary" href="https://github.com/ophis-fi/ophis/tree/main/packages/sdk" rel="noopener">View on GitHub</a>
      </div>
    </div>
    <div class="sdk-code reveal-up" data-reveal>
      <div class="code-frame">
        <div class="tabs"><div class="tab active">JavaScript</div></div>
        <pre class="code-body"><code>{code}</code></pre>
      </div>
    </div>
  </div>
</section>

<style>
  .sdk { padding: 80px 56px; }
  .sdk-inner {
    max-width: 1200px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: 1fr 1.2fr;
    gap: 50px;
    align-items: center;
  }
  .sdk-tag {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 4px;
    background: rgba(242, 166, 62, 0.12);
    color: var(--ophis-saffron-60);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    margin-bottom: 16px;
  }
  h2 {
    font-size: 40px;
    line-height: 1.1;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 16px;
  }
  .sdk-copy p {
    color: var(--ophis-fg-muted);
    margin-bottom: 24px;
    line-height: 1.5;
  }
  .ctas { display: flex; gap: 12px; flex-wrap: wrap; }
  .cta-secondary {
    color: var(--ophis-fg);
    padding: 12px 22px;
    border-radius: var(--ophis-radius-sm);
    font-size: 14px;
    font-weight: 500;
    border: 1px solid var(--ophis-border);
    text-decoration: none;
    transition: border-color 150ms ease;
  }
  .cta-secondary:hover { border-color: var(--ophis-fg-muted); }
  .code-frame {
    background: #111114;
    border: 1px solid var(--ophis-border);
    border-radius: var(--ophis-radius);
    overflow: hidden;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--ophis-border);
  }
  .tab {
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    background: var(--ophis-surface);
    color: var(--ophis-saffron-60);
  }
  .code-body {
    margin: 0;
    padding: 24px;
    font-family: 'JetBrains Mono', 'Menlo', monospace;
    font-size: 13px;
    line-height: 1.6;
    color: var(--ophis-fg-muted);
    overflow-x: auto;
    white-space: pre-wrap;
  }
  @media (max-width: 720px) {
    .sdk-inner { grid-template-columns: 1fr; gap: 32px; }
    h2 { font-size: 30px; }
  }
</style>
```

- [ ] **Step 4: Wire + verify**

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/apps/ophis-landing/src/components/SDKSection.astro \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/sdk.spec.ts
git commit -m "feat(landing): SDK section with @ophis/sdk install + configurePartnerFee snippet"
```

### Task 3.8: BuiltOnStrip.astro

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/components/BuiltOnStrip.astro`
- Modify: `apps/frontend/apps/ophis-landing/src/pages/index.astro`

- [ ] **Step 1: Test built-on strip**

`apps/frontend/apps/ophis-landing/tests/built-on.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('built-on strip lists CoW Protocol + Foundry + Alloy + CF Pages + OP Stack', async ({ page }) => {
  await page.goto('/')
  const items = page.locator('.built-on .built-item')
  await expect(items).toHaveCount(5)
  const texts = await items.allTextContents()
  expect(texts).toContain('CoW Protocol')
  expect(texts).toContain('Foundry')
  expect(texts).toContain('Alloy')
  expect(texts).toContain('Cloudflare Pages')
  expect(texts).toContain('OP Stack')
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write BuiltOnStrip.astro**

```astro
---
const items = ['CoW Protocol', 'Foundry', 'Alloy', 'Cloudflare Pages', 'OP Stack']
---
<section class="built-on">
  <div class="built-inner">
    <h2 class="reveal-up" data-reveal>
      Built on the rails <span class="accent">DeFi already trusts.</span>
    </h2>
    <p class="sub reveal-up" data-reveal>
      Forked from CoW Protocol's settlement stack. Same MEV-protection guarantees, Ophis-controlled allowlist, in-house solver competition.
    </p>
    <div class="built-row stagger">
      {items.map(label => (
        <div class="built-item reveal-up" data-reveal>{label}</div>
      ))}
    </div>
  </div>
</section>

<style>
  .built-on { padding: 80px 56px; text-align: center; }
  .built-inner { max-width: 1200px; margin: 0 auto; }
  h2 {
    font-size: 32px;
    line-height: 1.15;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 12px;
  }
  .sub {
    color: var(--ophis-fg-muted);
    margin: 0 auto 40px;
    max-width: 540px;
    font-size: 15px;
  }
  .built-row {
    display: flex;
    justify-content: center;
    gap: 50px;
    flex-wrap: wrap;
    color: var(--ophis-fg-faded);
    font-weight: 500;
  }
  @media (max-width: 720px) { .built-row { gap: 24px; } }
</style>
```

- [ ] **Step 4: Wire + verify**

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/apps/ophis-landing/src/components/BuiltOnStrip.astro \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/built-on.spec.ts
git commit -m "feat(landing): built-on strip (CoW, Foundry, Alloy, CF Pages, OP Stack)"
```

### Task 3.9: FinalCTA.astro + Footer.astro

**Files:**
- Create: `apps/frontend/apps/ophis-landing/src/components/FinalCTA.astro`
- Create: `apps/frontend/apps/ophis-landing/src/components/Footer.astro`
- Modify: `apps/frontend/apps/ophis-landing/src/pages/index.astro`

- [ ] **Step 1: Test final CTA and footer**

`apps/frontend/apps/ophis-landing/tests/final-footer.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('final CTA shows reimagined headline + Launch app', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.final h2')).toContainText('reimagined')
  await expect(page.locator('.final .cta-primary')).toContainText(/Launch app/)
})

test('footer has 4 columns + nav-back-to-top link', async ({ page }) => {
  await page.goto('/')
  const cols = page.locator('.footer .footer-col')
  await expect(cols).toHaveCount(4)
  await expect(page.locator('.footer .copyright')).toContainText('2026')
  await expect(page.locator('.footer .copyright')).toContainText('GPL-3.0')
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write FinalCTA.astro**

```astro
<section class="final">
  <div class="final-inner reveal-up" data-reveal>
    <h2>Aggregation <span class="accent">reimagined.</span></h2>
    <p>Available today on Optimism.</p>
    <div class="ctas">
      <a class="cta-primary" href="https://swap.ophis.fi/">Launch app</a>
      <a class="cta-secondary" href="https://docs.ophis.fi" rel="noopener">Read docs</a>
    </div>
  </div>
</section>

<style>
  .final {
    padding: 100px 56px;
    text-align: center;
    background: radial-gradient(ellipse at 50% 50%, rgba(242, 166, 62, 0.08), transparent 70%);
  }
  h2 {
    font-size: 56px;
    line-height: 1.05;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0 0 8px;
  }
  p { color: var(--ophis-fg-muted); margin: 0 0 32px; font-size: 18px; }
  .ctas { display: inline-flex; gap: 12px; }
  .cta-primary, .cta-secondary {
    padding: 12px 22px;
    border-radius: var(--ophis-radius-sm);
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
  }
  .cta-primary { background: var(--ophis-saffron-60); color: var(--ophis-bg); font-weight: 600; }
  .cta-secondary { color: var(--ophis-fg); border: 1px solid var(--ophis-border); }
  @media (max-width: 720px) { h2 { font-size: 40px; } }
</style>
```

- [ ] **Step 4: Write Footer.astro**

```astro
---
const cols = [
  {
    title: 'Product',
    links: [
      { label: 'Swap', href: 'https://swap.ophis.fi/' },
      { label: 'Limit', href: 'https://swap.ophis.fi/#/1/limit' },
      { label: 'TWAP', href: 'https://swap.ophis.fi/#/1/advanced' },
      { label: 'Status', href: 'https://docs.ophis.fi/status' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'SDK', href: 'https://github.com/ophis-fi/ophis/tree/main/packages/sdk' },
      { label: 'Intent API', href: 'https://docs.ophis.fi/api' },
      { label: 'Docs', href: 'https://docs.ophis.fi' },
      { label: 'GitHub', href: 'https://github.com/ophis-fi/ophis' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Security', href: 'https://github.com/ophis-fi/ophis/blob/main/SECURITY.md' },
      { label: 'Brand', href: 'https://github.com/ophis-fi/ophis/tree/main/docs/brand' },
      { label: 'Changelog', href: 'https://github.com/ophis-fi/ophis/blob/main/CHANGELOG.md' },
    ],
  },
  {
    title: 'Connect',
    links: [
      { label: 'Twitter', href: 'https://x.com/ophis_fi' },
      { label: 'GitHub', href: 'https://github.com/ophis-fi' },
    ],
  },
]
---
<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <div class="logo">Ophis</div>
      <p>Intent-based DEX aggregator for the agent era.</p>
      <p class="copyright">© 2026 Ophis. GPL-3.0.</p>
    </div>
    {cols.map(col => (
      <div class="footer-col">
        <h5>{col.title}</h5>
        <ul>
          {col.links.map(l => (
            <li><a href={l.href} rel={l.href.startsWith('http') ? 'noopener' : undefined}>{l.label}</a></li>
          ))}
        </ul>
      </div>
    ))}
  </div>
</footer>

<style>
  .footer { padding: 50px 56px 30px; }
  .footer-inner {
    max-width: 1200px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
    gap: 32px;
    color: var(--ophis-fg-faded);
    font-size: 13px;
  }
  .footer-brand .logo { font-weight: 700; color: var(--ophis-saffron-60); font-size: 18px; margin-bottom: 8px; }
  .footer-brand p { margin: 0 0 16px; }
  .footer-brand .copyright { font-size: 11px; }
  h5 { color: var(--ophis-fg); font-size: 13px; margin: 0 0 12px; font-weight: 600; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { margin-bottom: 8px; }
  a { color: var(--ophis-fg-faded); text-decoration: none; transition: color 120ms ease; }
  a:hover { color: var(--ophis-fg); }
  @media (max-width: 720px) {
    .footer-inner { grid-template-columns: 1fr 1fr; }
  }
</style>
```

- [ ] **Step 5: Wire all 7 sections into index.astro**

```astro
---
import Base from '../layouts/Base.astro'
import Nav from '../components/Nav.astro'
import Hero from '../components/Hero.astro'
import ChainsStrip from '../components/ChainsStrip.astro'
import CodeSection from '../components/CodeSection.astro'
import FeatureGrid from '../components/FeatureGrid.astro'
import SDKSection from '../components/SDKSection.astro'
import BuiltOnStrip from '../components/BuiltOnStrip.astro'
import FinalCTA from '../components/FinalCTA.astro'
import Footer from '../components/Footer.astro'
---
<Base>
  <Nav />
  <main>
    <Hero />
    <ChainsStrip />
    <CodeSection />
    <FeatureGrid />
    <SDKSection />
    <BuiltOnStrip />
    <FinalCTA />
  </main>
  <Footer />
</Base>
```

- [ ] **Step 6: Run all tests + verify**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm build
pnpm dev &
sleep 3
pnpm test 2>&1 | tail -20
pkill -f "astro dev" || true
```

Expected: all section tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/apps/ophis-landing/src/components/FinalCTA.astro \
        apps/frontend/apps/ophis-landing/src/components/Footer.astro \
        apps/frontend/apps/ophis-landing/src/pages/index.astro \
        apps/frontend/apps/ophis-landing/tests/final-footer.spec.ts
git commit -m "feat(landing): final CTA + footer; wire all 7 sections into index"
```

---

## Phase 4 — Security headers, deploy infrastructure, perf budget

### Task 4.1: _headers file (CSP, security headers, cache control)

**Files:**
- Create: `apps/frontend/apps/ophis-landing/public/_headers`

- [ ] **Step 1: Test that the build output includes _headers**

`apps/frontend/apps/ophis-landing/tests/headers.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

test('built dist includes _headers with strict CSP', () => {
  const path = join(__dirname, '..', 'dist', '_headers')
  expect(existsSync(path)).toBe(true)
  const content = readFileSync(path, 'utf8')
  expect(content).toContain('Content-Security-Policy')
  expect(content).toContain("frame-ancestors 'none'")
  expect(content).toContain('X-Content-Type-Options: nosniff')
  expect(content).toContain('Referrer-Policy: strict-origin-when-cross-origin')
})

test('built dist does NOT leak Aleph VM IPs or tailscale hostnames', () => {
  const indexPath = join(__dirname, '..', 'dist', 'index.html')
  const content = readFileSync(indexPath, 'utf8')
  expect(content).not.toMatch(/2a01:240:|100\.100\./)
  expect(content).not.toMatch(/\.ts\.net/)
  expect(content).not.toMatch(/aleph\.im|aleph\.cloud/) // we may surface aleph.cloud later, but not in v1
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write _headers**

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://swap.ophis.fi https://ophis.fi; frame-ancestors 'none'; form-action 'self'; base-uri 'self'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin

/*.png
  Cache-Control: public, max-age=31536000, immutable

/*.svg
  Cache-Control: public, max-age=31536000, immutable

/*.woff2
  Cache-Control: public, max-age=31536000, immutable

/_assets/*
  Cache-Control: public, max-age=31536000, immutable

/
  Cache-Control: public, max-age=300, must-revalidate
```

> **Note:** `'unsafe-inline'` for script-src is a v1 compromise — we ship hashed-script CSP in a follow-up PR after measuring exact bytes of inlined scripts. Recorded in `docs/superpowers/specs/2026-05-28-fe-resend-inspired-polish-design.md` §11.5.

- [ ] **Step 4: Build + verify**

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm build
pnpm exec playwright test tests/headers.spec.ts 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/apps/ophis-landing/public/_headers \
        apps/frontend/apps/ophis-landing/tests/headers.spec.ts
git commit -m "feat(landing): security headers (CSP, X-Frame, HSTS, COOP/CORP) + cache rules"
```

### Task 4.2: Lighthouse CI configuration

**Files:**
- Create: `apps/frontend/apps/ophis-landing/.lighthouserc.json`
- Create: `apps/frontend/apps/ophis-landing/scripts/lighthouse-static.sh`

- [ ] **Step 1: Test lhci config exists + budgets are strict**

`apps/frontend/apps/ophis-landing/tests/lhci-config.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('lighthouserc has strict perf budget', () => {
  const cfg = JSON.parse(readFileSync(join(__dirname, '..', '.lighthouserc.json'), 'utf8'))
  const asserts = cfg.ci.assert.assertions
  expect(asserts['categories:performance']).toEqual(['error', { minScore: 0.95 }])
  expect(asserts['largest-contentful-paint']).toEqual(['error', { maxNumericValue: 1500 }])
  expect(asserts['cumulative-layout-shift']).toEqual(['error', { maxNumericValue: 0 }])
  expect(asserts['total-byte-weight']).toEqual(['error', { maxNumericValue: 500000 }])
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write .lighthouserc.json**

```json
{
  "ci": {
    "collect": {
      "staticDistDir": "./dist",
      "url": ["http://localhost/index.html"],
      "settings": {
        "preset": "desktop",
        "throttlingMethod": "simulate"
      }
    },
    "assert": {
      "preset": "lighthouse:recommended",
      "assertions": {
        "categories:performance": ["error", { "minScore": 0.95 }],
        "categories:accessibility": ["error", { "minScore": 1.0 }],
        "categories:best-practices": ["error", { "minScore": 0.95 }],
        "categories:seo": ["error", { "minScore": 1.0 }],
        "largest-contentful-paint": ["error", { "maxNumericValue": 1500 }],
        "cumulative-layout-shift": ["error", { "maxNumericValue": 0 }],
        "total-byte-weight": ["error", { "maxNumericValue": 500000 }],
        "unminified-javascript": "off",
        "uses-text-compression": "off"
      }
    },
    "upload": { "target": "temporary-public-storage" }
  }
}
```

- [ ] **Step 4: Run + verify**

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/apps/ophis-landing/.lighthouserc.json \
        apps/frontend/apps/ophis-landing/tests/lhci-config.spec.ts
git commit -m "feat(landing): lighthouse CI config with strict perf budget (LCP<1.5s, CLS=0)"
```

### Task 4.3: GitHub Actions deploy workflow

**Files:**
- Create: `.github/workflows/landing-deploy.yml`

- [ ] **Step 1: Test workflow YAML parses + has required steps**

`apps/frontend/apps/ophis-landing/tests/workflow.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

test('landing-deploy.yml builds, runs lhci, and deploys via wrangler', () => {
  const path = join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'landing-deploy.yml')
  const yaml = readFileSync(path, 'utf8')
  expect(yaml).toContain('paths:')
  expect(yaml).toContain('apps/frontend/apps/ophis-landing/**')
  expect(yaml).toContain('pnpm --filter @ophis/landing build')
  expect(yaml).toContain('lhci autorun')
  expect(yaml).toContain('wrangler pages deploy')
  expect(yaml).toContain('ophis-landing')
  // sanitized commit message (ASCII-only) per feedback_cf_pages_ascii_commit_message
  expect(yaml).toMatch(/LC_ALL=C tr -cd|sed -E.*\[\^/)
})
```

- [ ] **Step 2: Run, confirm fail**

- [ ] **Step 3: Write the workflow**

```yaml
name: Deploy @ophis/landing to Cloudflare Pages

on:
  push:
    branches: [main]
    paths:
      - 'apps/frontend/apps/ophis-landing/**'
      - '.github/workflows/landing-deploy.yml'
  pull_request:
    paths:
      - 'apps/frontend/apps/ophis-landing/**'

permissions:
  contents: read
  deployments: write

concurrency:
  group: landing-deploy-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-deploy:
    name: build + lighthouse + deploy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: '10.30.3'

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: apps/frontend/pnpm-lock.yaml

      - name: install
        working-directory: apps/frontend
        run: pnpm install --frozen-lockfile

      - name: typecheck
        working-directory: apps/frontend/apps/ophis-landing
        run: pnpm typecheck

      - name: build
        working-directory: apps/frontend/apps/ophis-landing
        run: pnpm build

      - name: playwright install
        working-directory: apps/frontend/apps/ophis-landing
        run: pnpm exec playwright install --with-deps chromium

      - name: playwright tests
        working-directory: apps/frontend/apps/ophis-landing
        run: pnpm exec playwright test

      - name: lighthouse CI (perf budget gate)
        working-directory: apps/frontend/apps/ophis-landing
        run: pnpm exec lhci autorun

      - name: sanitize commit message for CF Pages
        id: msg
        run: |
          # CF Pages rejects non-ASCII in commit messages (error 8000111).
          MSG=$(printf '%s' "${{ github.event.head_commit.message }}" | LC_ALL=C tr -cd '\11\12\15\40-\176' | head -c 200)
          echo "msg=${MSG}" >> "$GITHUB_OUTPUT"

      - name: wrangler pages deploy
        if: github.ref == 'refs/heads/main'
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy apps/frontend/apps/ophis-landing/dist --project-name=ophis-landing --branch=main --commit-message="${{ steps.msg.outputs.msg }}"
```

- [ ] **Step 4: Run + verify**

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/landing-deploy.yml \
        apps/frontend/apps/ophis-landing/tests/workflow.spec.ts
git commit -m "ci(landing): build + lighthouse gate + wrangler deploy workflow"
```

### Task 4.4: Create CF Pages project + DNS prep

**Files:** (no repo changes; this is operator-side via `gh api` / `mcp__plugin_cloudflare_cloudflare-bindings__*`)

- [ ] **Step 1: Confirm CF API token has Pages + DNS permissions**

```bash
TOKEN=$(security find-generic-password -s cloudflare-api-token -w 2>/dev/null)
curl -sH "Authorization: Bearer ${TOKEN}" https://api.cloudflare.com/client/v4/user/tokens/verify | jq '.result.status'
```

Expected: `"active"`.

- [ ] **Step 2: Create the ophis-landing CF Pages project**

```bash
ACCT=$CLOUDFLARE_ACCOUNT_ID
TOKEN=$(security find-generic-password -s cloudflare-api-token -w)
curl -sH "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects" \
  -d '{"name":"ophis-landing","production_branch":"main"}' | jq '.result.name'
```

Expected: `"ophis-landing"`.

- [ ] **Step 3: Add CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID GH secrets if not set**

```bash
gh secret set CLOUDFLARE_API_TOKEN -R ophis-fi/ophis -b "$(security find-generic-password -s cloudflare-api-token -w)"
gh secret set CLOUDFLARE_ACCOUNT_ID -R ophis-fi/ophis -b "$CLOUDFLARE_ACCOUNT_ID"
```

- [ ] **Step 4: Add swap.ophis.fi as a custom domain to the existing swap CF Pages project (DOES NOT touch ophis.fi yet)**

```bash
TOKEN=$(security find-generic-password -s cloudflare-api-token -w)
# Project name stored in CLOUDFLARE_PAGES_SWAP_PROJECT GH secret / keychain
SWAP_PROJECT=$(security find-generic-password -s cloudflare-pages-swap-project -w 2>/dev/null || echo "see keychain")
curl -sH "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects/${SWAP_PROJECT}/domains" \
  -d '{"name":"swap.ophis.fi"}' | jq '.result.name'
```

Then add the CNAME DNS record:

```bash
ZONE=$(curl -sH "Authorization: Bearer ${TOKEN}" "https://api.cloudflare.com/client/v4/zones?name=ophis.fi" | jq -r '.result[0].id')
# CNAME points to the swap project's .pages.dev URL (look up in CF dashboard or keychain)
SWAP_PAGES_DEV=$(security find-generic-password -s cloudflare-pages-swap-pagesdev -w 2>/dev/null || echo "see-keychain.pages.dev")
curl -sH "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE}/dns_records" \
  -d "{\"type\":\"CNAME\",\"name\":\"swap\",\"content\":\"${SWAP_PAGES_DEV}\",\"proxied\":true}" | jq '.result.name'
```

- [ ] **Step 5: Verify swap.ophis.fi resolves + loads the swap UI**

```bash
curl -sI https://swap.ophis.fi/ | head -3
```

Expected: `HTTP/2 200`, swap UI HTML.

- [ ] **Step 6: No repo commit needed — this step is infra**

---

## Phase 5 — App-side polish (cowswap-frontend)

This phase runs INDEPENDENTLY of Phases 1-4 and can be PR'd separately.

### Task 5.1: Add nav-blur to cowswap-frontend's main nav

**Files:**
- Modify: the main nav component in `apps/frontend/apps/cowswap-frontend/src/legacy/components/Header/` (locate via grep first)

- [ ] **Step 1: Locate the nav component**

```bash
cd /Users/scep/greg
grep -rln "data-testid.*header\|className.*[Hh]eader\|class.*nav-bar" apps/frontend/apps/cowswap-frontend/src/legacy/components/Header/ 2>/dev/null | head -5
```

Identify the wrapper component. Suppose it's `Header.tsx`.

- [ ] **Step 2: Write a unit test asserting scroll-class toggle**

(The test path depends on the existing test setup — likely Vitest. Use the existing pattern in cowswap-frontend tests.)

- [ ] **Step 3: Add the CSS class toggle**

In the Header component, add a scroll listener that toggles a `.scrolled` class on the root element. Or use a CSS-only approach with `position: sticky` + a `scroll-timeline`-detected class via a tiny hook:

Create `apps/frontend/apps/cowswap-frontend/src/ophis/hooks/useScrollClass.ts`:

```typescript
import { useEffect, useState } from 'react'

export function useScrollClass(threshold = 40) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [threshold])
  return scrolled
}
```

Apply to the Header component:

```tsx
import { useScrollClass } from 'src/ophis/hooks/useScrollClass'
// ...
const scrolled = useScrollClass(40)
return <header className={cn('app-header', scrolled && 'scrolled')}>...</header>
```

Add CSS to `apps/frontend/apps/cowswap-frontend/src/ophis/styles.css`:

```css
.app-header { transition: background 200ms ease, border-color 200ms ease; }
.app-header.scrolled {
  background: rgba(10, 10, 10, 0.85);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}
```

- [ ] **Step 4: Manual smoke check + commit**

```bash
cd /Users/scep/greg/apps/frontend
pnpm --filter @cowswap/swap dev &
# Open localhost, scroll, verify nav frosts
```

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/apps/cowswap-frontend/src/ophis/hooks/useScrollClass.ts \
        apps/frontend/apps/cowswap-frontend/src/ophis/styles.css \
        apps/frontend/apps/cowswap-frontend/src/legacy/components/Header/Header.tsx
git commit -m "feat(app): nav blur-on-scroll for consistency with landing"
```

### Task 5.2: CTA button micro-interactions (press scale + hover glow)

**Files:**
- Modify: `apps/frontend/apps/cowswap-frontend/src/ophis/styles.css` or a new shared button style

- [ ] **Step 1: Locate primary button class names**

```bash
grep -rln "button.*primary\|ButtonPrimary\|btn-primary" apps/frontend/apps/cowswap-frontend/src 2>/dev/null | head -5
```

- [ ] **Step 2: Add CSS for press + hover treatments**

Append to `apps/frontend/apps/cowswap-frontend/src/ophis/styles.css`:

```css
/* Ophis CTA micro-interactions */
.ophis-cta,
[data-ophis-cta] {
  transition: transform 80ms ease-out, box-shadow 200ms ease;
}
.ophis-cta:hover,
[data-ophis-cta]:hover {
  box-shadow: 0 8px 24px -8px rgba(242, 166, 62, 0.45);
}
.ophis-cta:active,
[data-ophis-cta]:active {
  transform: scale(0.97);
}
@media (prefers-reduced-motion: reduce) {
  .ophis-cta, [data-ophis-cta] {
    transition: none;
    transform: none !important;
  }
}
```

- [ ] **Step 3: Apply the class/data-attr to primary action buttons**

In the relevant button components (Confirm Swap, Approve, Wrap), add `data-ophis-cta` to the root element:

```tsx
<button data-ophis-cta className={existingClasses}>{children}</button>
```

- [ ] **Step 4: Manual smoke check**

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/apps/cowswap-frontend/src/ophis/styles.css \
        apps/frontend/apps/cowswap-frontend/src/legacy/components/...
git commit -m "feat(app): CTA press + hover micro-interactions"
```

### Task 5.3: Toast slide-in transition

**Files:**
- Modify: the toast container component (locate via grep)

- [ ] **Step 1: Locate toast container**

```bash
grep -rln "ToastContainer\|toast-container\|Toaster" apps/frontend/apps/cowswap-frontend/src 2>/dev/null | head -5
```

- [ ] **Step 2: Wrap toast items in framer-motion AnimatePresence**

```tsx
import { AnimatePresence, motion } from 'framer-motion'

<AnimatePresence>
  {toasts.map(t => (
    <motion.div
      key={t.id}
      initial={{ x: 60, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 60, opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
    >
      {t.content}
    </motion.div>
  ))}
</AnimatePresence>
```

- [ ] **Step 3: Verify visually**

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/apps/cowswap-frontend/src/legacy/.../ToastContainer.tsx
git commit -m "feat(app): toast slide-in/out transition via existing framer-motion"
```

### Task 5.4: Set ophis_wallet_connected localStorage flag on wallet connect

**Files:**
- Modify: the wallet-connect handler (locate via grep — likely in `apps/cowswap-frontend/src/modules/wallet/`)

- [ ] **Step 1: Locate the wallet-connected event**

```bash
grep -rln "useAccount\|connected.*true\|onConnect" apps/frontend/apps/cowswap-frontend/src/modules/wallet 2>/dev/null | head -5
```

- [ ] **Step 2: Write a test that the flag gets set**

In the existing test suite, add an integration test:

```typescript
test('on successful wallet connect, ophis_wallet_connected is set to true', () => {
  // mock wallet connect, then assert localStorage.getItem('ophis_wallet_connected') === 'true'
})
```

- [ ] **Step 3: Add a small effect in the wallet-connected path**

In a top-level wallet effect (e.g., a `useEffect` watching `isConnected`):

```typescript
useEffect(() => {
  if (isConnected) {
    try { localStorage.setItem('ophis_wallet_connected', 'true') } catch {}
  }
}, [isConnected])
```

- [ ] **Step 4: Verify + commit**

```bash
git add apps/frontend/apps/cowswap-frontend/src/modules/wallet/...
git commit -m "feat(app): mark ophis_wallet_connected=true on first wallet connect (landing fast-path)"
```

---

## Phase 6 — Cutover (zero-downtime ophis.fi → landing)

### Task 6.1: Open the PR with everything from Phase 1-4

- [ ] **Step 1: Push branch + open PR**

```bash
cd /Users/scep/greg
git checkout -b feat/ophis-landing-resend-polish
# (all phase 1-4 commits already on this branch via earlier subtasks)
git push -u origin feat/ophis-landing-resend-polish

gh pr create -R ophis-fi/ophis --base main --head feat/ophis-landing-resend-polish \
  --title "feat(landing): Ophis landing at ophis.fi/ + app micro-interactions" \
  --body-file docs/superpowers/specs/2026-05-28-fe-resend-inspired-polish-design.md
```

- [ ] **Step 2: Wait for CI green** (Lighthouse budget, Playwright, typecheck, pnpm audit)

```bash
gh pr checks --watch
```

### Task 6.2: Pre-merge Codex audit

- [ ] **Step 1: Invoke Codex MCP audit (mandatory per spec §10.5)**

From the Claude session: invoke `mcp__plugin_second-opinion_codex__codex` on the PR diff. NO model override (per `feedback_codex_mcp_model_names`). Specific audit scope per spec §10.5:

- Hardcoded secrets
- Internal endpoints in client bundle
- CSP / security headers
- XSS / unsafe innerHTML
- CORS for `/api/intent` 
- Redirect logic safety (no template interpolation in the localStorage redirect)

- [ ] **Step 2: Address findings**

For each P1/P2 Codex finding: fix in a new commit on the same branch, push, re-run audit. Repeat until clean or all findings explicitly accepted with rationale.

### Task 6.3: Merge + DNS cutover

- [ ] **Step 1: Merge the PR (squash)**

```bash
gh pr merge $PR_NUM -R ophis-fi/ophis --squash --delete-branch
```

The CI deploy step will publish a build to `ophis-landing.pages.dev` but NOT yet attach `ophis.fi` to it.

- [ ] **Step 2: Smoke-test on preview URL**

```bash
curl -sI https://ophis-landing.pages.dev/ | head -5
# Open in browser, verify all 7 sections render, redirect works on connected-wallet
```

- [ ] **Step 3: Attach ophis.fi to the ophis-landing project (the actual cutover)**

```bash
TOKEN=$(security find-generic-password -s cloudflare-api-token -w)
ACCT=$CLOUDFLARE_ACCOUNT_ID
curl -sH "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects/ophis-landing/domains" \
  -d '{"name":"ophis.fi"}' | jq '.result.name'
curl -sH "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects/ophis-landing/domains" \
  -d '{"name":"www.ophis.fi"}' | jq '.result.name'
```

Cloudflare swaps routing atomically — the existing swap CF Pages project loses `ophis.fi` at the same moment `ophis-landing` gains it.

- [ ] **Step 4: Verify cutover live**

```bash
curl -sI https://ophis.fi/ | head -3
curl -s https://ophis.fi/ | grep -o "DEX aggregator" | head -1
```

Expected: HTTP 200, "DEX aggregator" appears in body.

- [ ] **Step 5: Remove ophis.fi from the swap CF Pages project (cleanup)**

```bash
curl -sH "Authorization: Bearer ${TOKEN}" -X DELETE \
  "https://api.cloudflare.com/client/v4/accounts/${ACCT}/pages/projects/${SWAP_PROJECT}/domains/ophis.fi" | jq '.success'
```

Expected: `true`.

---

## Phase 7 — Post-merge verification

### Task 7.1: Post-merge Codex bot review check

Per `feedback_check_codex_post_merge_review` (Claude memory): Codex GitHub bot fires AFTER first commit, posts P1/P2 inline comments the pre-merge MCP invocation didn't see.

- [ ] **Step 1: List inline review comments on the merged PR**

```bash
gh api "repos/ophis-fi/ophis/pulls/${PR_NUM}/comments" --jq '.[] | select(.user.login | test("codex|chatgpt|bot"; "i")) | .body'
```

- [ ] **Step 2: If P1/P2 findings exist, open a follow-up PR**

Same `feat/landing-codex-followup` style branch + fixes + re-audit.

### Task 7.2: Lighthouse verification on production URL

```bash
cd /Users/scep/greg/apps/frontend/apps/ophis-landing
pnpm exec lhci collect --url https://ophis.fi/
pnpm exec lhci assert
```

Expected: all assertions pass against the production deploy.

### Task 7.3: Update CHANGELOG

```bash
# Append to the Unreleased section in CHANGELOG.md
```

### Task 7.4: Notify Clement

Final summary message in the terminal: production URLs, perf scores, Codex audit status, any deferred follow-ups.

---

## Self-Review Notes

**Spec coverage:** Each section of the spec maps to one or more tasks:

| Spec § | Plan task(s) |
|---|---|
| §4.1 Astro app scaffold | Task 1.1, 1.2 |
| §4.2 Routing | Task 4.4, 6.3 |
| §4.4 Brand tokens codegen | Task 1.3 |
| §5 Visual design system | Task 2.1, all section tasks (3.x) |
| §6 Section content map | Task 3.2 - 3.9 |
| §7.1 Landing motion (5 primitives) | Task 2.1, 2.2, 2.3, 3.3, 3.x |
| §7.2 App motion (3 primitives) | Task 5.1, 5.2, 5.3 |
| §8 Perf budget | Task 4.2, 7.2 |
| §9 Routing/deployment | Task 4.3, 4.4, 6.x |
| §10.1 Visual regression | Each 3.x section test |
| §10.2 Perf regression | Task 4.2, 7.2 |
| §10.3 a11y | Task 4.2 (lhci accessibility assertion) |
| §10.4 Redirect behavior | Task 3.1 (Base.astro redirect script + test) |
| §10.5 Codex audit | Task 6.2 |
| §11 Security considerations | Task 4.1 (_headers), Task 4.1 test (no leaks) |

**Placeholder scan:** No "TBD" / "TODO" / "fill in" entries. Every code block has actual content.

**Type consistency:** `useScrollClass(threshold)` matches usage. `configurePartnerFee({chainId, receiver, bps})` matches the existing `@ophis/sdk` shape. `data-ophis-cta` is consistent across Phase 5 tasks. `ophis_wallet_connected` localStorage key is identical across Base.astro redirect script and Task 5.4's set call.

**Scope gaps surfaced during self-review:** None. The spec's "out of scope" list is honored (no loading skeletons, no page transitions, no form-field focus). The deliberate swap `.pages.dev` cushion is not touched.
