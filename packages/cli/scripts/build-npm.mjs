// Builds the npm package in dist/npm: one Node file with every dependency inside (the patched cow-sdk copies
// included, which a plain npm install would not apply), a package.json with no dependencies, and the README.
// Run from packages/cli: pnpm build:npm. Bun's bundler output does not run under Node, so esbuild bundles it.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const out = 'dist/npm'
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

execFileSync(
  'npx',
  ['-y', 'esbuild@0.25.10', 'src/main.ts', '--bundle', '--platform=node', '--format=cjs', '--target=node20',
    // Packages' ES builds first: some CommonJS builds hand a default import the whole module (SignClient.init fails).
    '--main-fields=module,main', '--minify', '--legal-comments=none', '--log-level=warning', `--outfile=${out}/ophis.js`],
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
  files: ['ophis.js', 'README.md'],
  engines: { node: '>=20' },
}
writeFileSync(`${out}/package.json`, `${JSON.stringify(published, null, 2)}\n`)
copyFileSync('README.md', `${out}/README.md`)
console.log(`Built ${out}: ${published.name}@${published.version}`)
