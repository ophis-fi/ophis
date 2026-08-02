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
const wrongCount = llms
  .match(/\b(\d+) EVM (?:\w+ )?(?:chains|networks)\b/gi)
  ?.filter((s) => !s.startsWith(`${count} `))
if (wrongCount?.length) {
  failures.push(`public/llms.txt contains a stale count: ${[...new Set(wrongCount)].join(', ')}`)
}
for (const name of names) {
  if (!llms.includes(name)) failures.push(`public/llms.txt is missing chain "${name}"`)
}

// 1b. BOTH directions: the advertised "EVM chains: A, B, ... and Z." sentence
// must equal the chains.ts set exactly. A retired chain left in the sentence
// (with only the numeric count updated) must fail, not just a missing one.
const listMatch = llms.match(/EVM chains:\s*([^.]+)\./)
if (!listMatch) {
  failures.push('public/llms.txt has no "EVM chains: ..." list sentence to verify')
} else {
  const advertised = listMatch[1]
    .split(',')
    .map((s) => s.replace(/^\s*and\s+/, '').trim())
    .filter(Boolean)
  const want = new Set(names)
  for (const n of advertised) {
    if (!want.has(n)) failures.push(`public/llms.txt advertises "${n}" which is not in chains.ts`)
  }
  const got = new Set(advertised)
  for (const n of names) {
    if (!got.has(n)) failures.push(`public/llms.txt chain-list sentence is missing "${n}"`)
  }
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
  // Separator-suffixed so a sibling like src/content.config.ts is NOT exempt.
  if (file.startsWith(`${contentDir}/`)) continue
  const text = readFileSync(file, 'utf8')
  // Optional middle word + chains|networks so "12 EVM Production chains" (the
  // motivating incident) and "13 EVM networks" phrasings are caught too.
  const hits = text.match(/\b\d+ EVM (?:\w+ )?(?:chains|networks)\b/gi)
  if (hits) {
    failures.push(
      `${relative(root, file)} hardcodes "${hits[0]}" — interpolate EVM_CHAIN_COUNT from src/data/chains.ts instead`,
    )
  }
}

// 3. Cross-check against the swap app's runtime chain list. The landing keeps
// its own presentation data (full names, strip order, logos), but its CHAIN
// IDS must equal apps/frontend/libs/common-const/src/chainInfo.ts
// SORTED_CHAIN_IDS, the product's authoritative list; otherwise the landing,
// llms.txt, and structured data can advertise chains the app retired, or
// miss ones it gained, while this gate stays green.
const chainInfoPath = resolve(root, '../../libs/common-const/src/chainInfo.ts')
const chainInfoSrc = readFileSync(chainInfoPath, 'utf8')
const sortedBlock = chainInfoSrc.match(/SORTED_CHAIN_IDS[^=]*=\s*\[([\s\S]*?)\]/)
if (!sortedBlock) {
  failures.push('could not locate SORTED_CHAIN_IDS in libs/common-const/src/chainInfo.ts')
} else {
  // Enum member -> canonical chain id. An entry this map does not know FAILS
  // the build (fail-closed on novelty): update this map AND src/data/chains.ts
  // together when the product gains a chain.
  const ENUM_IDS = {
    MAINNET: 1,
    BNB: 56,
    BASE: 8453,
    ARBITRUM_ONE: 42161,
    POLYGON: 137,
    AVALANCHE: 43114,
    LINEA: 59144,
    PLASMA: 9745,
    INK: 57073,
    GNOSIS_CHAIN: 100,
    OPTIMISM: 10,
    SEPOLIA: 11155111,
  }
  const appIds = []
  // Strip line comments first (they run to end of line), THEN split the whole
  // block on commas: entries are comma-delimited, not line-delimited, so two
  // entries sharing a physical line must both be parsed. Each fragment must
  // match an ANCHORED entry pattern in full — an unparsed suffix fails the
  // gate instead of being silently discarded.
  const entries = sortedBlock[1]
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const entry of entries) {
    const num = entry.match(/^(\d+)(?:\s+as\b[\w\s.]*)?$/)
    const member = entry.match(/^(?:SupportedChainId|AdditionalTargetChainId)\.(\w+)(?:\s+as\b[\w\s.]*)?$/)
    if (num) {
      appIds.push(Number(num[1]))
    } else if (member) {
      if (!(member[1] in ENUM_IDS)) {
        failures.push(
          `SORTED_CHAIN_IDS has an enum member this gate does not know: "${member[1]}" — add it to ENUM_IDS in this script AND the chain to src/data/chains.ts`,
        )
      } else {
        appIds.push(ENUM_IDS[member[1]])
      }
    } else {
      failures.push(`unparseable SORTED_CHAIN_IDS entry: "${entry}"`)
    }
  }
  const landingIds = [...chainsSrc.matchAll(/chainId: (\d+)/g)].map((m) => Number(m[1]))
  const appSet = new Set(appIds)
  const landingSet = new Set(landingIds)
  for (const id of appIds) {
    if (!landingSet.has(id)) {
      failures.push(`swap app SORTED_CHAIN_IDS lists chain ${id} but src/data/chains.ts does not`)
    }
  }
  for (const id of landingIds) {
    if (!appSet.has(id)) {
      failures.push(`src/data/chains.ts advertises chain ${id} which is not in the swap app's SORTED_CHAIN_IDS`)
    }
  }
}

if (failures.length) {
  console.error('check-chain-count: FAIL')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `check-chain-count: OK — ${count} EVM chains consistent across chains.ts, llms.txt, src/, and the swap app's SORTED_CHAIN_IDS`,
)
