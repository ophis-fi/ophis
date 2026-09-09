// node scripts/check-steep-content.cjs http://127.0.0.1:3017
// Public views only: no wallet connection, signature, claim, or form submission.
const assert = require('node:assert/strict')
const { chromium, webkit } = require('playwright')
const { mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const base = process.argv[2] || 'http://127.0.0.1:3017'
const artifacts = join(tmpdir(), 'ophis-steep-content-review')
mkdirSync(artifacts, { recursive: true })
const lightLogos = ['/ophis-wordmark.svg', '/ophis-icon-mono-dark.svg', '/ophis-logo-alt.svg']

// Check the DOM metadata contract; physical browser toolbar rendering is platform-owned.
async function checkThemeColor(page, dark) {
  const expected = dark ? '#17191c' : '#ffffff'
  await page.waitForFunction(
    (color) => document.querySelector('meta[name="theme-color"]')?.getAttribute('content')?.toLowerCase() === color,
    expected,
  )
  assert.equal(await page.locator('meta[name="theme-color"]').count(), 1, 'ambiguous duplicate theme-color tags')
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    dark ? 'dark' : 'light',
    'theme-color must match the effective route theme',
  )
}

async function check(page, dark, label) {
  const googleRequests = []
  const localFonts = []
  page.on('request', (request) => {
    if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(new URL(request.url()).hostname))
      googleRequests.push(request.url())
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin === new URL(base).origin && url.pathname === '/static/Inter-roman.var.woff2') {
      localFonts.push(response.status())
    }
  })
  await page.addInitScript(
    ({ dark }) => {
      localStorage.setItem('ophis_consent', 'denied')
      localStorage.setItem('redux_localstorage_simple_user', JSON.stringify({ userDarkMode: dark }))
    },
    { dark },
  )
  await page.goto(base + '/#/brand', { waitUntil: 'domcontentloaded' })
  await page.locator('#logos img').first().waitFor()
  await checkThemeColor(page, dark)
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    dark ? 'dark' : 'light',
    'saved theme was not applied',
  )
  const logos = await page.locator('#logos img').evaluateAll(async (images) => {
    const luminance = (rgb) =>
      rgb
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    return Promise.all(
      images.map(async (image) => {
        await image.decode()
        const tile = image.parentElement
        const style = getComputedStyle(tile)
        const background = luminance(style.backgroundColor.match(/\d+/g).slice(0, 3).map(Number))
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = Math.max(1, Math.round((256 * image.naturalHeight) / image.naturalWidth))
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let contrast = 1
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] < 240) continue
          const ink = luminance([pixels[i], pixels[i + 1], pixels[i + 2]])
          contrast = Math.max(contrast, (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05))
        }
        return { src: image.getAttribute('src'), background: style.backgroundColor, text: style.color, contrast }
      }),
    )
  })
  assert.ok(
    logos.some((logo) => logo.src === '/ophis-icon-inverse.svg'),
    'inverse logo preview missing',
  )
  for (const logo of logos) {
    const light = lightLogos.includes(logo.src)
    assert.equal(logo.background, light ? 'rgb(255, 255, 255)' : 'rgb(23, 25, 28)', logo.src + ' preview background')
    assert.equal(logo.text, light ? 'rgb(23, 25, 28)' : 'rgb(244, 244, 245)', logo.src + ' preview label')
    // Logos are not body text: detect an invisible asset, not enforce a text AA ratio.
    assert.ok(logo.contrast >= 1.8, logo.src + ' disappears against its preview background')
  }
  await page.evaluate(() => document.fonts.ready)
  assert.ok(
    await page.evaluate(() =>
      [...document.fonts].some((font) => font.family.replaceAll('"', '') === 'Inter var' && font.status === 'loaded'),
    ),
    'self-hosted Inter face not loaded',
  )
  await page.locator('#logos').screenshot({ path: join(artifacts, label + '-logos.png') })

  await page.goto(base + '/#/rewards', { waitUntil: 'domcontentloaded' })
  await page.locator('[class*=ProgressTrack]').first().waitFor()
  await checkThemeColor(page, dark)
  const tracks = await page.locator('[class*=ProgressTrack]').evaluateAll((elements) =>
    elements.map((track) => ({
      background: getComputedStyle(track).backgroundColor,
      cardBackground: getComputedStyle(track.closest('article')).backgroundColor,
      height: track.offsetHeight,
      width: track.offsetWidth,
      fill: track.firstElementChild.getBoundingClientRect().width,
    })),
  )
  for (const track of tracks) {
    assert.equal(track.fill, 0, 'disconnected wallet must show an empty reward track')
    assert.equal(track.height, 6)
    assert.ok(track.width > 0)
    assert.notEqual(track.background, 'rgba(0, 0, 0, 0)', 'empty reward track is transparent')
    assert.notEqual(track.background, track.cardBackground, 'empty reward track blends into its card')
  }
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'reward page overflow',
  )
  await page
    .locator('[class*=PerkCard]')
    .first()
    .screenshot({ path: join(artifacts, label + '-reward.png') })
  await page.goto(base + '/#/1/swap/USDC/ETH', { waitUntil: 'domcontentloaded' })
  await page.locator('#input-currency-input').waitFor()
  await checkThemeColor(page, false)
  await page.evaluate(() => document.fonts.ready)
  assert.deepEqual(googleRequests, [], 'active chrome requested Google Fonts')
  assert.ok(localFonts.includes(200), 'local Inter font did not return HTTP 200')
  const descriptions = await page.evaluate(async () => {
    const shell = new DOMParser().parseFromString(await (await fetch('/')).text(), 'text/html')
    const metadata = [
      'meta[name="description"]',
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
    ].map((selector) => shell.querySelector(selector)?.getAttribute('content'))
    const structuredData = [...shell.querySelectorAll('script[type="application/ld+json"]')].flatMap((script) => {
      const schema = JSON.parse(script.textContent)
      return schema['@graph'] || [schema]
    })
    return [...metadata, structuredData.find((item) => item['@type'] === 'WebApplication')?.description]
  })
  for (const description of descriptions)
    assert.match(description || '', /tokens and amount, review the quote, and sign/i)
  // Same-document navigation verifies restoration after leaving the forced-light swap.
  await page.evaluate(() => {
    location.hash = '/rewards'
  })
  await page.locator('[class*=ProgressTrack]').first().waitFor()
  await checkThemeColor(page, dark)
  console.log(
    'PASS',
    label,
    'logo assets, local Inter, no Google Fonts, empty reward tracks, shell descriptions and route theme-color restoration',
  )
}

;(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium ? { channel: 'chrome' } : {}) })
    try {
      for (const dark of [false, true]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 950 }, reducedMotion: 'reduce' })
        try {
          await check(await context.newPage(), dark, engine.name() + '-' + (dark ? 'dark' : 'light'))
        } finally {
          await context.close()
        }
      }
    } finally {
      await browser.close()
    }
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
