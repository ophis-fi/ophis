import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const CHUNK_SIZE = 23_000

const REQUIRED_MARKERS = [
  '<!doctype html>',
  '<title>Ophis Lite',
  'Content-Security-Policy',
  "script-src 'none'",
  "connect-src 'none'",
  'no execution',
]

const REJECTED_SOURCE_PATTERNS = [
  { pattern: /<script\b/i, reason: 'executable script' },
  { pattern: /<link\b/i, reason: 'external or mutable link resource' },
  { pattern: /https?:\/\//i, reason: 'remote URL' },
  { pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/, reason: 'network API' },
  { pattern: /\b(?:Date\.now|Math\.random|crypto\.randomUUID)\b/, reason: 'nondeterministic API' },
  { pattern: /\/Users\/|[A-Z]:\\/i, reason: 'machine-local path' },
  { pattern: /\{\{[^}]+\}\}/, reason: 'unresolved build token' },
]

function sha256(bytes) {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`
}

function castKeccak256(bytes) {
  const encoded = `0x${bytes.toString('hex')}`
  const digest = execFileSync('cast', ['keccak', encoded], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }).trim()

  if (!/^0x[0-9a-f]{64}$/.test(digest)) {
    throw new Error('cast returned an invalid Keccak-256 digest')
  }
  return digest
}

function validateSource(html) {
  if (html.includes('\r')) {
    throw new Error('source must use LF line endings')
  }
  for (const marker of REQUIRED_MARKERS) {
    if (!html.includes(marker)) {
      throw new Error(`source is missing required marker: ${marker}`)
    }
  }
  for (const rejected of REJECTED_SOURCE_PATTERNS) {
    if (rejected.pattern.test(html)) {
      throw new Error(`source contains ${rejected.reason}`)
    }
  }
}

export function buildArtifact(source, keccak256 = castKeccak256) {
  const html = Buffer.from(source)
  validateSource(html.toString('utf8'))

  const chunks = []
  for (let offset = 0; offset < html.length; offset += CHUNK_SIZE) {
    const bytes = html.subarray(offset, Math.min(offset + CHUNK_SIZE, html.length))
    chunks.push({
      index: chunks.length,
      offset,
      length: bytes.length,
      sha256: sha256(bytes),
      keccak256: keccak256(bytes),
    })
  }

  return {
    html,
    manifest: {
      schemaVersion: 1,
      product: 'Ophis Lite',
      version: '0.0.1',
      mode: 'local-prototype',
      deploymentAuthorized: false,
      source: 'src/index.html',
      output: 'dist/index.html',
      encoding: 'utf-8',
      byteLength: html.length,
      sha256: sha256(html),
      keccak256: keccak256(html),
      chunkSize: CHUNK_SIZE,
      chunks,
    },
  }
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
