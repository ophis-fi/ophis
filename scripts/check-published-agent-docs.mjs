#!/usr/bin/env node

// Fail closed before deploying docs that advertise an npm package version.
// Source/manifest drift is covered by check-network-docs-invariant.mjs; this
// deployment gate covers the second boundary: every claimed artifact must
// already exist in the public npm registry. Successful agent release workflows
// retrigger docs-deploy.yml, so a delayed release leaves the previous truthful
// docs live and publishes the new docs automatically once all artifacts exist.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path) => JSON.parse(read(path));

const aiAgents = read('apps/docs-ophis/docs/ai-agents.md');
const sdkPackage = readJson('packages/sdk/package.json');
const adapterPackagePaths = [
  'packages/agent-swap/package.json',
  'packages/agentkit-ophis/package.json',
  'packages/plugin-goat/package.json',
  'packages/plugin-elizaos/package.json',
];
const adapterPackages = adapterPackagePaths.map(readJson);
const skillsPackage = readJson('packages/agent-skills/package.json');
const packages = [sdkPackage, ...adapterPackages, skillsPackage];

const documentedAdapterVersions = aiAgents.split('\n').flatMap((line) => {
  const row = line.match(
    /^\| \[`(@ophis\/[^`]+)`\]\(https:\/\/www\.npmjs\.com\/package\/\1\)\s*\| v(\d+\.\d+\.\d+)\s*\|/,
  );
  return row ? [{ name: row[1], version: row[2] }] : [];
});

assert.equal(
  documentedAdapterVersions.length,
  adapterPackages.length,
  'AI-agent docs must contain exactly one versioned table row for every npm adapter',
);
for (const manifest of adapterPackages) {
  const documentedRows = documentedAdapterVersions.filter(({ name }) => name === manifest.name);
  assert.deepEqual(
    documentedRows,
    [{ name: manifest.name, version: manifest.version }],
    `AI-agent docs must advertise exactly ${manifest.name}@${manifest.version}`,
  );
}

assert.ok(
  aiAgents.includes(
    `The v${adapterPackages[0].version} adapter family is built and published against \`@ophis/sdk\` v${sdkPackage.version}`,
  ),
  `AI-agent docs must advertise ${sdkPackage.name}@${sdkPackage.version} with the adapter family`,
);
assert.ok(
  aiAgents.includes(`**\`@ophis/sdk\`**, published on npm (v${sdkPackage.version}, public)`),
  `AI-agent SDK instructions must advertise ${sdkPackage.name}@${sdkPackage.version}`,
);
assert.ok(
  aiAgents.includes(
    `[` +
      `\`@ophis/agent-skills\`` +
      `](https://www.npmjs.com/package/@ophis/agent-skills)\nv${skillsPackage.version} for runtimes`,
  ),
  `AI-agent docs must advertise ${skillsPackage.name}@${skillsPackage.version}`,
);

const RETRIES = 12;
const RETRY_DELAY_MS = 5_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPublishedManifest({ name, version }) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let lastStatus = 'request failed';

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      lastStatus = `${response.status} ${response.statusText}`;
      if (response.ok) return response.json();
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    if (attempt < RETRIES) await delay(RETRY_DELAY_MS);
  }

  throw new Error(
    `${name}@${version} is not available from the public npm registry (${lastStatus})`,
  );
}

for (const manifest of packages) {
  const published = await fetchPublishedManifest(manifest);
  assert.equal(
    published.name,
    manifest.name,
    `npm returned the wrong package for ${manifest.name}`,
  );
  assert.equal(
    published.version,
    manifest.version,
    `npm version for ${manifest.name} does not match the documented manifest`,
  );
}

console.log(
  `OK: ${packages.map(({ name, version }) => `${name}@${version}`).join(', ')} exist in the public npm registry.`,
);
