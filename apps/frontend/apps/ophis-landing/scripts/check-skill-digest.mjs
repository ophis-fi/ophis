#!/usr/bin/env node
/**
 * Build-time integrity gate: FAIL the build if the agent-skills discovery
 * manifest advertises a digest that no longer matches the SKILL.md bytes it
 * points at. Agents fetch index.json, then verify each SKILL.md they download
 * against the advertised sha256; a stale digest makes the skill un-loadable
 * (or masks a tampered file). Regenerate with `shasum -a 256 <SKILL.md>` and
 * paste `sha256:<hex>` back into index.json.
 *
 * Wired into the landing `prebuild` script, so both `dev` and `build` run it.
 */
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const publicDir = resolve(root, 'public')
const indexPath = resolve(publicDir, '.well-known/agent-skills/index.json')

const manifest = JSON.parse(readFileSync(indexPath, 'utf8'))
const skills = Array.isArray(manifest.skills) ? manifest.skills : []

const failures = []
for (const skill of skills) {
  if (skill.type !== 'skill-md' || typeof skill.url !== 'string') continue
  // Map the advertised URL back to the local asset under public/.
  const pathname = new URL(skill.url).pathname
  const localPath = resolve(publicDir, '.' + pathname)
  let bytes
  try {
    bytes = readFileSync(localPath)
  } catch {
    failures.push(`${skill.name}: SKILL.md not found at ${localPath}`)
    continue
  }
  const actual = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  if (skill.digest !== actual) {
    failures.push(
      `${skill.name}: digest is stale\n    index.json: ${skill.digest}\n    SKILL.md:   ${actual}`,
    )
  }
}

if (failures.length) {
  console.error('check-skill-digest: agent-skills manifest is stale:\n')
  for (const f of failures) console.error(`  ${f}`)
  console.error('\nRegenerate: shasum -a 256 <SKILL.md>, then paste sha256:<hex> into')
  console.error('public/.well-known/agent-skills/index.json.')
  process.exit(1)
}
console.log('check-skill-digest: OK - agent-skills manifest digests match SKILL.md')
