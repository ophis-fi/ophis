import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

test('lighthouserc has strict perf budget', () => {
  const cfg = JSON.parse(readFileSync(join(__dirname, '..', '.lighthouserc.json'), 'utf8'))
  const asserts = cfg.ci.assert.assertions
  expect(asserts['categories:performance']).toEqual(['error', { minScore: 0.95 }])
  expect(asserts['largest-contentful-paint']).toEqual(['error', { maxNumericValue: 1500 }])
  expect(asserts['cumulative-layout-shift']).toEqual(['error', { maxNumericValue: 0 }])
  expect(asserts['total-byte-weight']).toEqual(['error', { maxNumericValue: 500000 }])
})
