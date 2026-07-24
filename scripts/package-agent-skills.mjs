#!/usr/bin/env node
// Ophis - stage the @ophis/agent-skills npm package from the canonical family.
//
// The skill family served at ophis.fi/.well-known/agent-skills/ophis/ (in-repo:
// apps/frontend/apps/ophis-landing/public/.well-known/agent-skills/ophis/) is
// the single source of truth. This script stages packages/agent-skills for
// `npm pack` / `pnpm publish` by COPYING those files at build time; no skill
// content is ever committed under packages/agent-skills (the copies are
// gitignored), so the package cannot fork from the served family.
//
// Staged layout (everything below is a build artifact):
//   ophis/SKILL.md            byte-for-byte copy of the umbrella skill
//   ophis/skills/*.md         byte-for-byte copies of the five sub-skills
//   ophis/README.md           byte-for-byte copy of the family guide
//   ophis/LICENSE             byte-for-byte copy (MIT + retained upstream notice)
//   LICENSE                   package-root copy of the same family LICENSE
//   index.json                the family's slice of the hosted discovery
//                             manifest: identical digests, canonical ophis.fi
//                             URLs, same schema
//
// Hard gates (exit 1, staging is wiped on failure so a broken run cannot pack):
//   1. every family skill file's sha256 equals the digest advertised in the
//      hosted index.json (a mismatch means the manifest is stale and a release
//      would ship bytes the canonical index does not vouch for);
//   2. every skill file in the family directory is listed in the hosted
//      index.json (nothing ships unadvertised);
//   3. the family LICENSE still carries the MIT grant AND the retained
//      upstream skeleton copyright notice;
//   4. the umbrella SKILL.md still carries the machine-readable
//      metadata.openclaw.web3.policy block;
//   5. the umbrella frontmatter `version` equals packages/agent-skills
//      package.json `version`: skills-release.yml pins the git tag to
//      package.json, this pins package.json to the family, so one version
//      string flows tag -> package -> umbrella skill;
//   6. every staged copy byte-equals its source.
//
// Pure Node, no deps (house style: check-policy-pack-addresses.mjs /
// check-agent-skills-invariant.mjs). Run from anywhere:
//   node scripts/package-agent-skills.mjs

import { readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(REPO_ROOT, p);

const WELL_KNOWN = 'apps/frontend/apps/ophis-landing/public/.well-known/agent-skills';
const FAMILY_DIR = `${WELL_KNOWN}/ophis`;
const HOSTED_INDEX = `${WELL_KNOWN}/index.json`;
const FAMILY_URL_PREFIX = 'https://ophis.fi/.well-known/agent-skills/ophis/';
const PKG_DIR = 'packages/agent-skills';

const problems = [];
const fail = (msg) => problems.push(msg);
const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

// --- 1+2: the hosted manifest vouches for exactly the files we stage --------

const hostedIndex = JSON.parse(readFileSync(rel(HOSTED_INDEX), 'utf8'));
const familyEntries = hostedIndex.skills.filter((s) => s.url.startsWith(FAMILY_URL_PREFIX));

const familyFiles = [
  'SKILL.md',
  ...readdirSync(rel(`${FAMILY_DIR}/skills`))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `skills/${f}`),
];

for (const file of familyFiles) {
  const entry = familyEntries.find((s) => s.url === `${FAMILY_URL_PREFIX}${file}`);
  if (!entry) {
    fail(`${FAMILY_DIR}/${file} is not listed in ${HOSTED_INDEX}; nothing ships unadvertised`);
    continue;
  }
  const digest = sha256(readFileSync(rel(`${FAMILY_DIR}/${file}`)));
  if (digest !== entry.digest) {
    fail(`${FAMILY_DIR}/${file}: sha256 ${digest} != hosted index digest ${entry.digest} (stale manifest?)`);
  }
}
for (const entry of familyEntries) {
  const file = entry.url.slice(FAMILY_URL_PREFIX.length);
  if (!familyFiles.includes(file)) {
    fail(`${HOSTED_INDEX} advertises ${entry.url} but ${FAMILY_DIR}/${file} does not exist`);
  }
}

// --- 3: license text intact (MIT grant + retained upstream notice) ----------

const license = readFileSync(rel(`${FAMILY_DIR}/LICENSE`), 'utf8');
if (!/^MIT License$/m.test(license)) {
  fail(`${FAMILY_DIR}/LICENSE: missing the "MIT License" grant line`);
}
if (!/Portions copyright \(c\) \d{4} Odos/.test(license)) {
  fail(`${FAMILY_DIR}/LICENSE: the retained upstream skeleton copyright notice is gone; it is a license condition and must ship with every copy`);
}

// --- 4+5: umbrella policy block present, version pinned to package.json -----

const umbrella = readFileSync(rel(`${FAMILY_DIR}/SKILL.md`), 'utf8');
const frontmatter = umbrella.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
if (!/^\s+openclaw:$/m.test(frontmatter) || !/^\s+policy:$/m.test(frontmatter)) {
  fail(`${FAMILY_DIR}/SKILL.md: the metadata.openclaw.web3.policy block is missing from the frontmatter`);
}
const pkg = JSON.parse(readFileSync(rel(`${PKG_DIR}/package.json`), 'utf8'));
const umbrellaVersion = frontmatter.match(/^version: (\S+)$/m)?.[1];
if (umbrellaVersion !== pkg.version) {
  fail(
    `version drift: ${PKG_DIR}/package.json is ${pkg.version} but the umbrella SKILL.md frontmatter is ${umbrellaVersion}; ` +
      `bump both together (the skills-v* release tag must match this same string)`,
  );
}

const wipeStaging = () => {
  for (const p of ['ophis', 'LICENSE', 'index.json']) {
    rmSync(rel(`${PKG_DIR}/${p}`), { recursive: true, force: true });
  }
};

if (problems.length > 0) {
  wipeStaging();
  console.error(`package-agent-skills: ${problems.length} problem(s), nothing staged\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// --- stage -------------------------------------------------------------------

wipeStaging();
mkdirSync(rel(`${PKG_DIR}/ophis/skills`), { recursive: true });

const copies = [
  ...familyFiles.map((f) => [`${FAMILY_DIR}/${f}`, `${PKG_DIR}/ophis/${f}`]),
  [`${FAMILY_DIR}/README.md`, `${PKG_DIR}/ophis/README.md`],
  [`${FAMILY_DIR}/LICENSE`, `${PKG_DIR}/ophis/LICENSE`],
  [`${FAMILY_DIR}/LICENSE`, `${PKG_DIR}/LICENSE`],
];
for (const [src, dst] of copies) {
  copyFileSync(rel(src), rel(dst));
}

// The packaged manifest is the family's slice of the hosted one: identical
// digests and canonical URLs, so a consumer can verify the tarball's bytes
// against ophis.fi without trusting npm.
writeFileSync(
  rel(`${PKG_DIR}/index.json`),
  `${JSON.stringify({ $schema: hostedIndex.$schema, skills: familyEntries }, null, 2)}\n`,
);

// --- 6: staged copies byte-equal their sources -------------------------------

for (const [src, dst] of copies) {
  if (!readFileSync(rel(src)).equals(readFileSync(rel(dst)))) {
    wipeStaging();
    console.error(`package-agent-skills: staged copy ${dst} does not byte-equal ${src}; nothing staged`);
    process.exit(1);
  }
}

console.log(
  `OK: staged @ophis/agent-skills v${pkg.version} in ${PKG_DIR} ` +
    `(${familyFiles.length} skill files, digests verified against the hosted index, license notice intact)`,
);
