// Builds the npm package in dist/npm: one Node file with every dependency inside (the patched cow-sdk copies
// included, which a plain npm install would not apply), a package.json with no dependencies, and the README.
// Run from packages/cli: pnpm build:npm. Bun's bundler output does not run under Node, so esbuild bundles it.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = 'dist/npm'
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

execFileSync(
  'npx',
  ['-y', 'esbuild@0.25.10', 'src/main.ts', '--bundle', '--platform=node', '--format=cjs', '--target=node20',
    // Packages' ES builds first: some CommonJS builds hand a default import the whole module (SignClient.init fails).
    '--main-fields=module,main', '--minify', '--legal-comments=none', '--log-level=warning', `--metafile=${out}/meta.json`, `--outfile=${out}/ophis.js`],
  { stdio: 'inherit' },
)

// A Node launcher, and no runtime warnings meant for developers (a dependency's punycode use, Node's experimental
// localStorage) printed to the people using the CLI.
const quiet =
  'process.noDeprecation=true;{const e=process.emitWarning;process.emitWarning=(w,...a)=>{const t=typeof a[0]==="string"?a[0]:a[0]&&a[0].type;if(t!=="ExperimentalWarning")return e.call(process,w,...a)}}'
const body = readFileSync(`${out}/ophis.js`, 'utf8').replace(/^#!.*\n/, '')
writeFileSync(`${out}/ophis.js`, `#!/usr/bin/env node\n${quiet}\n${body}`)
chmodSync(`${out}/ophis.js`, 0o755)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const published = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  homepage: 'https://ophis.fi',
  repository: { type: 'git', url: 'git+https://github.com/ophis-fi/ophis.git', directory: 'packages/cli' },
  keywords: ['ophis', 'swap', 'bridge', 'cli', 'cow-protocol', 'walletconnect'],
  bin: { ophis: 'ophis.js' },
  files: ['ophis.js', 'README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.md'],
  engines: { node: '>=20' },
  publishConfig: { access: 'public' },
}
writeFileSync(`${out}/package.json`, `${JSON.stringify(published, null, 2)}\n`)
copyFileSync('README.md', `${out}/README.md`)
copyFileSync('../../LICENSE', `${out}/LICENSE`)

// Every bundled package's license and notice, as their licenses require (MIT, ISC, Apache-2.0, ...).
const roots = new Set()
for (const input of Object.keys(JSON.parse(readFileSync(`${out}/meta.json`, 'utf8')).inputs)) {
  const root = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1]
  if (root) roots.add(root)
}
const notices = [...roots]
  .map((root) => {
    const meta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const file = readdirSync(root).find((f) => /^(licen[cs]e|copying|notice)/i.test(f))
    const text = file ? readFileSync(join(root, file), 'utf8').trim() : `License: ${meta.license ?? 'see the package'}`
    return { id: `${meta.name}@${meta.version}`, text }
  })
  .sort((a, b) => a.id.localeCompare(b.id))
  .filter((n, i, all) => i === 0 || n.id !== all[i - 1].id)
writeFileSync(`${out}/THIRD_PARTY_LICENSES.md`, notices.map((n) => `## ${n.id}\n\n${n.text}\n`).join('\n'))
rmSync(`${out}/meta.json`)
if (!existsSync(`${out}/THIRD_PARTY_LICENSES.md`) || notices.length === 0) throw new Error('no third-party notices written')
console.log(`Built ${out}: ${published.name}@${published.version}`)
