import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildArtifact, serializeManifest } from './build-lib.mjs'

const sourceUrl = new URL('../src/index.html', import.meta.url)
const expectedManifestUrl = new URL('../config/expected-manifest.json', import.meta.url)
const deterministicKeccak = (bytes) => `0x${bytes.toString('hex').padEnd(64, '0').slice(0, 64)}`

test('build is byte-for-byte deterministic', async () => {
  const source = await readFile(sourceUrl)
  const first = buildArtifact(source, deterministicKeccak)
  const second = buildArtifact(source, deterministicKeccak)

  assert.deepEqual(first.html, second.html)
  assert.equal(serializeManifest(first.manifest), serializeManifest(second.manifest))
})

test('reviewed source matches the pinned manifest', async () => {
  const source = await readFile(sourceUrl)
  const expected = JSON.parse(await readFile(expectedManifestUrl, 'utf8'))
  const actual = buildArtifact(source).manifest

  assert.deepEqual(actual, expected)
})

test('external resources and executable code fail closed', () => {
  const source = '<!doctype html><title>Ophis Lite</title><script src="app.js"></script>'

  assert.throws(() => buildArtifact(source, deterministicKeccak), /missing required marker|executable script/)
})
