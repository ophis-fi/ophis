#!/usr/bin/env node
/**
 * Build gate: the supported-chain list has ONE source of truth
 * (src/data/chains.ts). This check fails the build when either:
 *
 *  1. public/llms.txt disagrees with it: the "N EVM chains" count phrase is
 *     missing, or any canonical chain name from the data file is absent
 *     (llms.txt is a static file, so it CAN drift; this locks it), or
 *  2. any file under src/ hardcodes a "N EVM chains" literal instead of
 *     interpolating EVM_CHAIN_COUNT (the exact drift that shipped "12 EVM
 *     Production chains" on business.ophis.fi after the Robinhood go-live).
 *
 * Runs pre-astro-build from the `build` script (it reads sources, not dist).
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const chainsSrc = readFileSync(resolve(root, 'src/data/chains.ts'), 'utf8')
// Entry names are the single-quoted `name:` fields of EVM_CHAINS. The
// NEAR_DESTINATIONS array uses bare strings, not `name:` keys, so this regex
// captures exactly the EVM set.
const names = [...chainsSrc.matchAll(/name: '([^']+)'/g)].map((m) => m[1])
const count = names.length
if (count === 0) {
  console.error('check-chain-count: FAIL — could not parse any chain names from src/data/chains.ts')
  process.exit(1)
}

const failures = []

// 1. llms.txt must carry the exact count phrase and every chain name.
const llms = readFileSync(resolve(root, 'public/llms.txt'), 'utf8')
if (!llms.includes(`${count} EVM chains`)) {
  failures.push(`public/llms.txt does not say "${count} EVM chains" (chains.ts has ${count} entries)`)
}
const wrongCount = llms.match(/\b(\d+) EVM chains\b/g)?.filter((s) => s !== `${count} EVM chains`)
if (wrongCount?.length) {
  failures.push(`public/llms.txt contains a stale count: ${[...new Set(wrongCount)].join(', ')}`)
}
for (const name of names) {
  if (!llms.includes(name)) failures.push(`public/llms.txt is missing chain "${name}"`)
}

// 2. No hardcoded "N EVM chains" literals in src/ — interpolate EVM_CHAIN_COUNT.
function walk(dir) {
  let out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out = out.concat(walk(p))
    else if (/\.(astro|ts|tsx|mjs|md)$/.test(entry)) out.push(p)
  }
  return out
}
const contentDir = resolve(root, 'src/content')
for (const file of walk(resolve(root, 'src'))) {
  // Blog posts are dated content: a count that was true at publication stays.
  if (file.startsWith(contentDir)) continue
  const text = readFileSync(file, 'utf8')
  const hits = text.match(/\b\d+ EVM chains\b/g)
  if (hits) {
    failures.push(
      `${relative(root, file)} hardcodes "${hits[0]}" — interpolate EVM_CHAIN_COUNT from src/data/chains.ts instead`,
    )
  }
}

if (failures.length) {
  console.error('check-chain-count: FAIL')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`check-chain-count: OK — ${count} EVM chains consistent across chains.ts, llms.txt, and src/`)
