import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

test('landing-deploy.yml builds, runs lhci, and deploys via wrangler', () => {
  const path = join(__dirname, '..', '..', '..', '..', '..', '.github', 'workflows', 'landing-deploy.yml')
  const yaml = readFileSync(path, 'utf8')
  expect(yaml).toContain('paths:')
  for (const event of ['push', 'pull_request']) {
    const paths = yaml.split(`  ${event}:`)[1].split(/^\S|^  \w/m)[0]
    expect(paths).toContain("'apps/frontend/package.json'")
    expect(paths).toContain("'apps/frontend/pnpm-lock.yaml'")
  }
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
  expect(yaml).toContain('--sitemap apps/frontend/apps/ophis-landing/dist/sitemap.xml')
})


test('landing Functions are restricted to API routes and retain shared middleware', () => {
  const root = join(__dirname, '..', '..', '..', '..', '..')
  const routes = JSON.parse(readFileSync(join(__dirname, '..', 'dist', '_routes.json'), 'utf8'))
  expect(routes).toEqual({ version: 1, include: ['/api/*'], exclude: [] })
  const workflow = readFileSync(join(root, '.github/workflows/landing-deploy.yml'), 'utf8')
  expect(workflow).toContain("'functions/**'")
  expect(workflow).not.toContain('dist/functions')
  const redirects = readFileSync(join(__dirname, '..', 'dist', '_redirects'), 'utf8')
  expect(redirects).toContain('/docs  https://docs.ophis.fi/  301')
  expect(redirects).toContain('/docs/*  https://docs.ophis.fi/:splat  301')
})
