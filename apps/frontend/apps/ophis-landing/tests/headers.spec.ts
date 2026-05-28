import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

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
