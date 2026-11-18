#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, dirname } = require('node:path')

// Bound regressions that block synchronously during glob preprocessing.
if (process.argv[2] !== '--worker') {
  const result = spawnSync(process.execPath, [__filename, '--worker', ...process.argv.slice(2)], {
    timeout: 10_000, encoding: 'utf8', maxBuffer: 1024 * 1024,
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}

const workspace = resolve(process.argv[3] || join(__dirname, '..'))
const workspaceRequire = createRequire(join(workspace, 'package.json'))
const nxPackage = workspaceRequire.resolve('nx/package.json')
const nxRequire = createRequire(nxPackage)
const minimatch = nxRequire('minimatch')
const version = nxRequire('minimatch/package.json').version
const [major, minor, patch] = version.split('.').map(Number)
assert(major > 11 || (major === 11 && (minor > 0 || patch >= 1)), `Unsafe minimatch ${version}`)

// Run the real Nx consumer: v11 removed makeRe, so package presence alone is insufficient.
const { findMatchingProjects, getMatchingStringsWithCache } = require(join(dirname(nxPackage), 'dist/src/utils/find-matching-projects.js'))
const projects = {
  swap: { name: 'swap', data: { root: 'apps/swap', tags: ['scope:public'] } },
  'swap-e2e': { name: 'swap-e2e', data: { root: 'apps/swap-e2e', tags: ['scope:test'] } },
  explorer: { name: 'explorer', data: { root: 'apps/explorer', tags: ['scope:public'] } },
  'wallet-provider': { name: 'wallet-provider', data: { root: 'libs/wallet-provider', tags: ['scope:shared'] } },
}
for (const [patterns, expected] of [
  [['name:swap*'], ['swap', 'swap-e2e']],
  [['*', '!name:*-e2e'], ['swap', 'explorer', 'wallet-provider']],
  [['directory:libs/*'], ['wallet-provider']],
  [['directory:apps/*', '!name:*-e2e'], ['swap', 'explorer']],
  [['tag:scope:public'], ['swap', 'explorer']],
  [['name:{swap,explorer}'], ['swap', 'explorer']],
]) assert.deepEqual(findMatchingProjects([...patterns], projects).sort(), expected.sort(), patterns.join(','))
for (const pattern of ['', '#comment']) {
  assert.throws(() => getMatchingStringsWithCache(pattern, ['swap']), /Invalid glob pattern/)
}
assert.deepEqual(findMatchingProjects([''], projects), [])

const files = ['src/index.ts', 'src/index.test.ts', 'src/App.tsx', 'README.md']
assert.deepEqual(files.filter(minimatch.minimatch.filter('**/*.{ts,tsx}')), files.slice(0, 3))
assert.deepEqual(files.filter(minimatch.minimatch.filter('!**/*.test.ts')), [files[0], files[2], files[3]])
const amplified = Array(24).fill('a/**/..').join('/') + '/*.js'
assert.throws(() => new minimatch.Minimatch(amplified, { optimizationLevel: 2 }), /pattern is too long/)

const treeRoot = mkdtempSync(join(tmpdir(), 'ophis-minimatch-'))
try {
  writeFileSync(join(treeRoot, 'nx.json'), '{}')
  writeFileSync(join(treeRoot, 'existing.ts'), '')
  writeFileSync(join(treeRoot, 'deleted.ts'), '')
  const { glob } = require(join(dirname(nxPackage), 'dist/src/generators/utils/glob.js'))
  const result = glob({ root: treeRoot, listChanges: () => [
    { path: 'created.ts', type: 'CREATE' },
    { path: 'created.md', type: 'CREATE' },
    { path: 'deleted.ts', type: 'DELETE' },
  ] }, ['**/*.ts'])
  assert.deepEqual(result.sort(), ['created.ts', 'existing.ts'])
  for (const pattern of ['', '#comment']) {
    assert.throws(() => glob({ root: treeRoot, listChanges: () => [] }, [pattern]), /Invalid glob pattern/)
  }
} finally {
  rmSync(treeRoot, { recursive: true, force: true })
}
async function checkReleaseBranchMatching() {
  const releaseDir = join(dirname(nxPackage), 'dist/src/command-line/release/utils')
  const commands = require(join(releaseDir, 'exec-command.js'))
  const { RepoGitTags } = require(join(releaseDir, 'repository-git-tags.js'))
  const original = commands.execCommand
  const calls = []
  commands.execCommand = async (_command, args) => {
    calls.push(args)
    return args[0] === 'rev-parse' ? 'release/security\n' : 'v1.0.0\n'
  }
  try {
    for (const [pattern, mergedOnly] of [['release/*', false], ['main*', true], ['', true], ['#comment', true]]) {
      calls.length = 0
      assert.deepEqual(await RepoGitTags.create().resolveTags([pattern]), ['v1.0.0'])
      assert.equal(calls[1].includes('--merged'), mergedOnly)
    }
  } finally {
    commands.execCommand = original
  }
}

checkReleaseBranchMatching().then(() => {
  console.log(`minimatch@${version}: Nx project selection, generator globs, release branches, filters and bounded preprocessing passed`)
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
