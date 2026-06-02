import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TOKENS_CSS = join(__dirname, '..', 'src', 'styles', 'tokens.css')
const GLOBAL_CSS = join(__dirname, '..', 'src', 'styles', 'global.css')

async function loadOphisStyles(page: import('@playwright/test').Page) {
  // tokens.css is generated, ensure it exists first
  if (!existsSync(TOKENS_CSS)) {
    // run prebuild to generate it
    const { execSync } = await import('node:child_process')
    execSync('node scripts/tokens-to-css.mjs', { cwd: join(__dirname, '..') })
  }
  await page.addStyleTag({ content: readFileSync(TOKENS_CSS, 'utf8') })
  // global.css imports tokens via @import; remove that line for the inline injection
  const globalCss = readFileSync(GLOBAL_CSS, 'utf8').replace(/@import[^;]+;\s*/, '')
  await page.addStyleTag({ content: globalCss })
  // Wait for styles to be applied — addStyleTag resolves when the sheet is added to the DOM
  // but a layout pass is needed before getComputedStyle is reliable.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
}

// Task 2.1 — global.css tests

test('reveal-up: fails open — visible until html.reveal-armed, then hidden unless .in-view', async ({ page }) => {
  // Disable transitions so opacity snaps to declared value immediately — avoids
  // mid-transition reads when CSS is injected after element creation.
  await page.setContent(`
    <style>*, *::before, *::after { transition: none !important; animation: none !important; }</style>
    <div class="reveal-up" id="t1">hello</div>
    <div class="reveal-up in-view" id="t2">visible</div>
  `)
  await loadOphisStyles(page)
  // FAIL-OPEN: until reveal.ts confirms IntersectionObserver and adds
  // html.reveal-armed, all content stays fully visible. So JS-off OR a failed/
  // absent reveal module can never blank the page (the prior bug + the new one
  // Codex flagged: JS on but reveal never runs).
  const failOpen = await page.locator('#t1').evaluate(el => getComputedStyle(el).opacity)
  expect(parseFloat(failOpen)).toBe(1)
  // Once the reveal bootstrap arms the gate, the hidden initial state applies;
  // .in-view (also scoped under html.reveal-armed) reveals it.
  await page.evaluate(() => document.documentElement.classList.add('reveal-armed'))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
  const hidden = await page.locator('#t1').evaluate(el => getComputedStyle(el).opacity)
  const active = await page.locator('#t2').evaluate(el => getComputedStyle(el).opacity)
  expect(parseFloat(hidden)).toBeLessThan(0.5)
  expect(parseFloat(active)).toBe(1)
})

test('claw has 40s spin animation', async ({ page }) => {
  await page.setContent(`<div class="claw"></div>`)
  await loadOphisStyles(page)
  const anim = await page.locator('.claw').evaluate(el => getComputedStyle(el).animationName)
  expect(anim).toBe('claw-spin')
})

test('prefers-reduced-motion suppresses claw and reveal', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.setContent(`
    <div class="reveal-up" id="r">hidden</div>
    <div class="claw" id="c"></div>
  `)
  await loadOphisStyles(page)
  // reveal-up should be opacity 1 (forced by media query !important)
  const revealOp = await page.locator('#r').evaluate(el => getComputedStyle(el).opacity)
  expect(parseFloat(revealOp)).toBe(1)
  const clawAnim = await page.locator('#c').evaluate(el => getComputedStyle(el).animationName)
  expect(clawAnim).toBe('none')
  await ctx.close()
})

// Particle field tests

test('particle has drift + twinkle animations', async ({ page }) => {
  await page.setContent(`<span class="particle particle--saffron" id="p"></span>`)
  await loadOphisStyles(page)
  const anim = await page.locator('#p').evaluate((el) => getComputedStyle(el).animationName)
  expect(anim).toContain('particle-drift')
  expect(anim).toContain('particle-twinkle')
})

test('prefers-reduced-motion suppresses particle animation (stays visible)', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.setContent(`<span class="particle particle--violet" id="p" style="--op:0.5"></span>`)
  await loadOphisStyles(page)
  const anim = await page.locator('#p').evaluate((el) => getComputedStyle(el).animationName)
  expect(anim).toBe('none')
  await ctx.close()
})

test('built dist renders a static aria-hidden particle field', async ({}, testInfo) => {
  const dist = join(__dirname, '..', 'dist', 'index.html')
  testInfo.skip(!existsSync(dist), 'dist/index.html not built yet')
  const html = readFileSync(dist, 'utf8')
  // The field container is aria-hidden so the dots never reach the a11y tree.
  expect(html).toMatch(/class="particles"[^>]*aria-hidden|aria-hidden[^>]*class="particles"/)
  // Field is statically rendered (no JS): expect many particle spans in the markup.
  const count = (html.match(/class="particle particle--/g) || []).length
  expect(count).toBeGreaterThanOrEqual(40)
})

// Task 2.2 — reveal.ts tests

test('reveal.ts adds .in-view when element is observed', async ({ page }) => {
  await page.setContent(`
    <div class="reveal-up" data-reveal id="r">visible after JS</div>
  `)
  await loadOphisStyles(page)
  const revealScript = readFileSync(join(__dirname, '..', 'src', 'lib', 'reveal.ts'), 'utf8')
    // strip TS syntax for inline injection
    .replace(/document\.querySelectorAll<HTMLElement>/g, 'document.querySelectorAll')
    .replace(/^export\s+\{\}\s*$/m, '')
  await page.addScriptTag({ content: revealScript })
  await page.waitForTimeout(120)
  await expect(page.locator('#r')).toHaveClass(/in-view/)
})

// Task 2.3 — nav-blur.ts tests

test('nav-blur toggles .scrolled past 40px scroll', async ({ page }) => {
  await page.setContent(`
    <div style="height: 200vh">
      <nav class="nav" id="nav">nav</nav>
    </div>
  `)
  await loadOphisStyles(page)
  // Strip the module's TS syntax so it parses when injected as a classic <script>.
  // nav-blur.ts is deliberately kept to a small, known set of TS constructs:
  // querySelector/querySelectorAll generics and single-param type annotations.
  const navBlurScript = readFileSync(join(__dirname, '..', 'src', 'lib', 'nav-blur.ts'), 'utf8')
    .replace(/\.(querySelector(?:All)?)<[^>]+>/g, '.$1') // generics: .querySelector(All)<T> -> .querySelector(All)
    .replace(/\((\w+):\s*[\w.]+\)/g, '($1)') // single-param annotations: (open: boolean) -> (open)
    .replace(/^export\s*\{\s*\};?\s*$/m, '')
  await page.addScriptTag({ content: navBlurScript })
  await expect(page.locator('#nav')).not.toHaveClass(/scrolled/)
  await page.evaluate(() => window.scrollTo(0, 100))
  await page.waitForTimeout(80)
  await expect(page.locator('#nav')).toHaveClass(/scrolled/)
})
