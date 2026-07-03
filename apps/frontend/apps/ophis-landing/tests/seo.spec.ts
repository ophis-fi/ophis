import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const dist = (f: string) => join(__dirname, '..', 'dist', f)
const read = (f: string) => readFileSync(dist(f), 'utf8')

// These assert the BUILT output (CI runs `astro build` before the tests).

test('robots.txt allows all + AI crawlers and points to the sitemap', () => {
  expect(existsSync(dist('robots.txt'))).toBe(true)
  const robots = read('robots.txt')
  expect(robots).toMatch(/User-agent:\s*\*/)
  expect(robots).toMatch(/Allow:\s*\//)
  expect(robots).toContain('Sitemap: https://ophis.fi/sitemap.xml')
  // AEO/GEO: answer-engine crawlers explicitly welcomed.
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
    expect(robots).toContain(bot)
  }
})

test('sitemap.xml is a valid urlset listing the canonical home URL', () => {
  expect(existsSync(dist('sitemap.xml'))).toBe(true)
  const sm = read('sitemap.xml')
  expect(sm).toContain('<urlset')
  expect(sm).toContain('http://www.sitemaps.org/schemas/sitemap/0.9')
  expect(sm).toContain('<loc>https://ophis.fi/</loc>')
})

test('llms.txt follows the standard (H1 + summary blockquote) and links agent surfaces', () => {
  expect(existsSync(dist('llms.txt'))).toBe(true)
  const llms = read('llms.txt')
  expect(llms).toMatch(/^# Ophis/m)
  expect(llms).toMatch(/^> /m) // summary blockquote
  expect(llms).toContain('https://mcp.ophis.fi/mcp')
  expect(llms).toContain('https://swap.ophis.fi/api/intent')
})

// Collect every JSON-LD block on a page and flatten to the schema.org types it
// declares (@graph nodes + standalone @type blocks).
const ldTypes = (html: string): string[] =>
  [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap(
    ([, body]) => {
      const data = JSON.parse(body)
      return (data['@graph'] ?? [data]).map((n: { '@type': string }) => n['@type'])
    },
  )

test('index.html embeds schema.org JSON-LD (Organization/WebSite sitewide + SoftwareApplication/HowTo home-only) and is parseable', () => {
  const html = read('index.html')
  const types = ldTypes(html)
  if (!types.length) throw new Error('JSON-LD <script> not found in index.html')
  expect(types).toEqual(
    expect.arrayContaining(['Organization', 'WebSite', 'SoftwareApplication', 'HowTo']),
  )
  // robots meta present.
  expect(html).toMatch(/<meta name="robots" content="index, follow/)
})

test('content pages carry the sitewide Organization/WebSite JSON-LD but NOT the app schema', () => {
  const types = ldTypes(read('blog/index.html'))
  expect(types).toEqual(expect.arrayContaining(['Organization', 'WebSite']))
  // The point of the homeSchema gate: a content page must not also declare the
  // app schema or the SDK HowTo (semantic noise for answer engines).
  expect(types).not.toContain('SoftwareApplication')
  expect(types).not.toContain('HowTo')
})
