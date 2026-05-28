import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

test('package.json defines @ophis/landing', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  expect(pkg.name).toBe('@ophis/landing')
  expect(pkg.private).toBe(true)
})

import { existsSync } from 'node:fs'

test('astro build produces dist/index.html', async () => {
  const distIndex = join(__dirname, '..', 'dist', 'index.html')
  expect(existsSync(distIndex)).toBe(true)
})
