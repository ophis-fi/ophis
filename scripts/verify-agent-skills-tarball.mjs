#!/usr/bin/env node
// Ophis - assert the exact @ophis/agent-skills tarball content.
//
// Shared by BOTH the skills-release.yml release job (before the token-bearing
// publish step) and the agent-skills-ci.yml static lane (merge gate), so a
// family change that alters the pack list fails at MERGE time, not after the
// release tag is pushed. Before this was shared, the release workflow carried
// a hand-maintained 12-file list: adding a legitimate new sub-skill passed
// every merge gate and then broke the release.
//
// The expected list is DERIVED, never hand-maintained:
//   - the skill files come from the staged manifest
//     (packages/agent-skills/index.json, itself the family's slice of the
//     hosted discovery manifest, digest-verified at staging time);
//   - plus the fixed package scaffolding (package.json, README.md, LICENSE,
//     index.json, ophis/README.md, ophis/LICENSE).
// Exact equality both ways: a file missing from the tarball and an unexpected
// extra both fail.
//
// Requires the staging to exist: run `node scripts/package-agent-skills.mjs`
// first (the CI static lane and the release workflow both do).
//
// Pure Node, no deps. Run from anywhere:
//   node scripts/verify-agent-skills-tarball.mjs

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = join(REPO_ROOT, 'packages/agent-skills');
const FAMILY_URL_PREFIX = 'https://ophis.fi/.well-known/agent-skills/ophis/';

const SCAFFOLDING = ['package.json', 'README.md', 'LICENSE', 'index.json', 'ophis/README.md', 'ophis/LICENSE'];

const manifestPath = join(PKG_DIR, 'index.json');
if (!existsSync(manifestPath)) {
  console.error(
    'verify-agent-skills-tarball: packages/agent-skills/index.json is missing.\n' +
      'Run the staging build first: node scripts/package-agent-skills.mjs',
  );
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const skillFiles = manifest.skills.map((s) => {
  if (typeof s.url !== 'string' || !s.url.startsWith(FAMILY_URL_PREFIX)) {
    console.error(`verify-agent-skills-tarball: staged manifest entry has a non-family url: ${s.url}`);
    process.exit(1);
  }
  return `ophis/${s.url.slice(FAMILY_URL_PREFIX.length)}`;
});

const want = [...SCAFFOLDING, ...skillFiles].sort();
if (new Set(want).size !== want.length) {
  console.error(`verify-agent-skills-tarball: duplicate expected path in ${want.join(', ')}`);
  process.exit(1);
}

// --ignore-scripts: assert the staged state exactly as the release job packs
// it (its publish step also runs with --ignore-scripts after the explicit
// staging build), not whatever a prepack re-run would regenerate.
const r = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: PKG_DIR,
  encoding: 'utf8',
});
if (r.status !== 0 || r.error) {
  console.error(`verify-agent-skills-tarball: npm pack --dry-run failed:\n${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}`);
  process.exit(1);
}
const got = JSON.parse(r.stdout)[0].files.map((f) => f.path).sort();

const missing = want.filter((w) => !got.includes(w));
const extra = got.filter((f) => !want.includes(f));
if (missing.length > 0 || extra.length > 0) {
  console.error(
    'verify-agent-skills-tarball: tarball does not match the staged manifest + scaffolding\n' +
      `  missing: ${missing.join(', ') || '(none)'}\n` +
      `  extra:   ${extra.join(', ') || '(none)'}`,
  );
  process.exit(1);
}

console.log(
  `OK: tarball contains exactly the ${want.length} expected files ` +
    `(${skillFiles.length} skill files from the staged manifest + ${SCAFFOLDING.length} scaffolding files).`,
);
