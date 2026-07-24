#!/usr/bin/env node
// Ophis - agent-skill family test suite (node:test, zero deps).
//
// Static (always):
//   - the cross-source invariant gate passes (scripts/check-agent-skills-invariant.mjs)
//   - the landing digest + completeness gate passes (also wired into the
//     landing `prebuild`, so `astro build` cannot ship a stale manifest)
//   - every skill file has well-formed frontmatter (name, description, license)
//   - every index.json digest recomputes against the shipped bytes
//   - the read-only skills carry at least one `ci:live-readonly` block for the
//     live canary to execute
//
// Live (opt-in, SKILLS_LIVE=1):
//   - executes every ```bash ci:live-readonly fenced block against the live
//     Ophis orderbook (read-only endpoints, no key, no secrets), one retry per
//     block. This is the daily canary in agent-skills-ci.yml: it proves the
//     published snippets still run against production, it gates nothing else.
//
// Run: node scripts/test-agent-skills.mjs        (static only)
//      SKILLS_LIVE=1 node scripts/test-agent-skills.mjs
//
// Uses node:test via `node --test`-free direct invocation so it runs on any
// Node >= 20 without flags.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(REPO_ROOT, p);

const WELL_KNOWN = 'apps/frontend/apps/ophis-landing/public/.well-known/agent-skills';
const FAMILY_DIR = `${WELL_KNOWN}/ophis`;

const FAMILY_SKILLS = [
  `${FAMILY_DIR}/SKILL.md`,
  `${FAMILY_DIR}/skills/ophis-quote.md`,
  `${FAMILY_DIR}/skills/ophis-swap.md`,
  `${FAMILY_DIR}/skills/ophis-order-status.md`,
  `${FAMILY_DIR}/skills/ophis-cancel.md`,
  `${FAMILY_DIR}/skills/ophis-surplus-report.md`,
];
const LIVE_BLOCK_SKILLS = [
  `${FAMILY_DIR}/skills/ophis-quote.md`,
  `${FAMILY_DIR}/skills/ophis-order-status.md`,
  `${FAMILY_DIR}/skills/ophis-surplus-report.md`,
];

const read = (p) => readFileSync(rel(p), 'utf8');
const liveBlocksOf = (src) => [...src.matchAll(/```bash ci:live-readonly\n([\s\S]*?)```/g)].map((m) => m[1]);

// --- static -----------------------------------------------------------------

test('invariant gate: skill policy matches SDK + backend constants', () => {
  const r = spawnSync(process.execPath, [rel('scripts/check-agent-skills-invariant.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `check-agent-skills-invariant.mjs failed:\n${r.stdout}${r.stderr}`);
});

test('digest gate: index.json digests + completeness (landing prebuild script)', () => {
  const r = spawnSync(
    process.execPath,
    [rel('apps/frontend/apps/ophis-landing/scripts/check-skill-digest.mjs')],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `check-skill-digest.mjs failed:\n${r.stdout}${r.stderr}`);
});

test('every family skill has frontmatter with name, description, MIT license', () => {
  for (const p of FAMILY_SKILLS) {
    const src = read(p);
    const fm = src.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    assert.ok(fm, `${p}: missing frontmatter`);
    assert.match(fm, /^name: [a-z][a-z-]*$/m, `${p}: bad or missing name`);
    assert.match(fm, /^description: .{40,}/m, `${p}: description missing or too short to trigger on`);
    assert.match(fm, /^license: MIT$/m, `${p}: license must be MIT`);
  }
});

test('index.json advertises the whole family and every digest recomputes', () => {
  const manifest = JSON.parse(read(`${WELL_KNOWN}/index.json`));
  const byName = new Map(manifest.skills.map((s) => [s.name, s]));
  const expected = ['swap-via-ophis', 'ophis', 'ophis-quote', 'ophis-swap', 'ophis-order-status', 'ophis-cancel', 'ophis-surplus-report'];
  for (const name of expected) {
    const skill = byName.get(name);
    assert.ok(skill, `index.json: missing skill "${name}"`);
    const pathname = decodeURIComponent(new URL(skill.url).pathname);
    const bytes = readFileSync(rel(`apps/frontend/apps/ophis-landing/public${pathname}`));
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    assert.equal(skill.digest, digest, `index.json: stale digest for "${name}"`);
  }
});

test('read-only skills carry ci:live-readonly blocks for the canary', () => {
  for (const p of LIVE_BLOCK_SKILLS) {
    assert.ok(liveBlocksOf(read(p)).length >= 1, `${p}: no ci:live-readonly block`);
  }
});

// --- live canary (SKILLS_LIVE=1) --------------------------------------------

if (process.env.SKILLS_LIVE === '1') {
  for (const p of LIVE_BLOCK_SKILLS) {
    const blocks = liveBlocksOf(read(p));
    blocks.forEach((block, i) => {
      test(`live: ${p.split('/').pop()} block ${i + 1} executes against production`, () => {
        const run = () =>
          spawnSync('bash', ['-euo', 'pipefail', '-c', block], { encoding: 'utf8', timeout: 60_000 });
        let r = run();
        if (r.status !== 0) r = run(); // one retry: tolerate a transient blip, not an outage
        assert.equal(r.status, 0, `live block failed twice:\n${block}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
      });
    });
  }
} else {
  test('live canary skipped (set SKILLS_LIVE=1 to execute read-only blocks against production)', () => {
    assert.ok(true);
  });
}
