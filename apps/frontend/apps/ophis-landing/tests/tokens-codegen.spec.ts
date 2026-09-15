import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TOKENS_CSS = join(__dirname, '..', 'src', 'styles', 'tokens.css')

test('tokens-to-css generates tokens.css from the Steep palette', () => {
  if (existsSync(TOKENS_CSS)) rmSync(TOKENS_CSS)
  execSync('node scripts/tokens-to-css.mjs', { cwd: join(__dirname, '..') })
  expect(existsSync(TOKENS_CSS)).toBe(true)
  const css = readFileSync(TOKENS_CSS, 'utf8')
  expect(css).toContain('--ophis-bg: #ffffff')
  expect(css).toContain('--ophis-fg: #17191c')
  expect(css).toContain('--ophis-surface: #f2f2f3')
  expect(css).toContain('--ophis-peach: #fbe1d1')
  expect(css).toContain('--ophis-brown: #5d2a1a')
  expect(css).toContain('--ophis-radius: 24px')
  expect(css).toContain('GENERATED')
})
