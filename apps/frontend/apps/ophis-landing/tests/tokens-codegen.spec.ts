import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TOKENS_CSS = join(__dirname, '..', 'src', 'styles', 'tokens.css')

test('tokens-to-css generates tokens.css from cowswap-frontend source', () => {
  if (existsSync(TOKENS_CSS)) rmSync(TOKENS_CSS)
  execSync('node scripts/tokens-to-css.mjs', { cwd: join(__dirname, '..') })
  expect(existsSync(TOKENS_CSS)).toBe(true)
  const css = readFileSync(TOKENS_CSS, 'utf8')
  expect(css).toContain('--ophis-saffron-60: #f2a63e')
  expect(css).toContain('--ophis-bg: #0a0a0a')
  expect(css).toContain('--ophis-fg-muted: rgba(255, 255, 255, 0.65)')
  expect(css).toContain('GENERATED')
})
