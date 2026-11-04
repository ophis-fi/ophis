import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const allowed = ['apps/broadcaster/package.json', 'apps/broadcaster/pnpm-lock.yaml',
  'apps/broadcaster/.npmrc', 'apps/broadcaster/dist/main.mjs', 'apps/railgun/patches/allowed.patch',
  'patches/elliptic@6.6.1.patch', 'patches/zod@3.25.76.patch']
const denied = ['apps/broadcaster/.env.context-canary', 'apps/broadcaster/data/context-canary',
  'apps/broadcaster/node_modules/context-canary', 'apps/broadcaster/dist/main.mjs.map',
  'apps/railgun/patches/context-canary', 'apps/unrelated/context-canary', 'patches/context-canary']
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })

function probe(ignore) {
  const root = mkdtempSync(join(tmpdir(), 'ophis-broadcaster-context-'))
  const image = `ophis-context-check:${randomUUID()}`
  let container
  try {
    for (const file of [...allowed, ...denied]) {
      const target = join(root, file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, 'DISPOSABLE_CONTEXT_FIXTURE\n')
    }
    writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\nCOPY . /context/\n')
    writeFileSync(join(root, 'Dockerfile.dockerignore'), ignore)
    docker(['build', '--pull=false', '-t', image, root])
    container = docker(['create', image, '/unused']).trim()
    const archive = join(root, 'context.tar')
    docker(['export', '--output', archive, container])
    return execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).split('\n')
  } finally {
    try { if (container) docker(['rm', container]) } catch { /* Daemon failures must not skip local cleanup. */ }
    try { docker(['image', 'rm', image]) } catch { /* Build failure may leave no image. */ }
    rmSync(root, { recursive: true, force: true })
  }
}

const ignore = readFileSync(new URL('../Dockerfile.dockerignore', import.meta.url), 'utf8')
const names = probe(ignore)
for (const file of allowed) assert(names.includes('context/' + file), `Required context file excluded: ${file}`)
for (const file of denied) assert(!names.includes('context/' + file), `Private/unrelated context file included: ${file}`)
// A directory re-include must fail the same canary check, rather than silently widening context.
const mutated = probe(ignore + '\n!apps/\n!patches/\n')
assert(denied.some(file => mutated.includes('context/' + file)), 'Negative control did not expose the broad directory pattern.')
console.log('Docker context contains required files, excludes private/unrelated canaries, and detects directory re-includes.')
