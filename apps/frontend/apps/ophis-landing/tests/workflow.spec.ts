import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

test('landing-deploy.yml builds, runs lhci, and deploys via wrangler', () => {
  const path = join(__dirname, '..', '..', '..', '..', '..', '.github', 'workflows', 'landing-deploy.yml')
  const yaml = readFileSync(path, 'utf8')
  expect(yaml).toContain('paths:')
  expect(yaml).toContain('apps/frontend/apps/ophis-landing/**')
  expect(yaml).toContain('pnpm --filter @ophis/landing build')
  expect(yaml).toContain('lhci autorun')
  expect(yaml).toContain('wrangler pages deploy')
  expect(yaml).toContain('ophis-landing')
  // sanitized commit message (ASCII-only) per feedback_cf_pages_ascii_commit_message
  expect(yaml).toMatch(/LC_ALL=C tr -cd|sed -E.*\[\^/)
  // commit message must NOT be interpolated directly into the run: shell string
  // (command injection prevention) — it must go through an env: var instead
  expect(yaml).not.toMatch(/printf.*\$\{\{.*head_commit\.message/)
  expect(yaml).toContain('RAW_MSG: ${{ github.event.head_commit.message }}')
})
