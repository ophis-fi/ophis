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

async function fetchPublishedManifest(packageName, registryUrl, version) {
  let lastStatus = 'request failed';

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(registryUrl, {
        signal: AbortSignal.timeout(10_000),
      });
      lastStatus = `${response.status} ${response.statusText}`;
      if (response.ok) {
        // Body consumption belongs inside the retryable operation: a truncated
        // or otherwise invalid 200 response must not escape as an uncaught
        // rejected promise.
        const packument = await response.json();
        const published = packument.versions?.[version];
        if (published) return published;
        lastStatus = `${lastStatus}; ${packageName}@${version} is absent`;
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }

    if (attempt < RETRIES) await delay(RETRY_DELAY_MS);
  }

  throw new Error(
    `${packageName}@${version} is not available from the public npm registry (${lastStatus})`,
  );
}

assert.deepEqual(
  packages.map(({ name }) => name),
  [
    '@ophis/sdk',
    '@ophis/agent-swap',
    '@ophis/agentkit-ophis',
    '@ophis/plugin-goat',
    '@ophis/plugin-elizaos',
    '@ophis/agent-skills',
  ],
  'npm registry allowlist drifted from the package manifests',
);

// Keep outbound destinations as source-controlled constants. Package-manifest
// file data selects only a version inside the returned registry document and
// can never influence the host or request path.
const publishedPackages = await Promise.all([
  fetchPublishedManifest(
    '@ophis/sdk',
    'https://registry.npmjs.org/%40ophis%2Fsdk',
    sdkPackage.version,
  ),
  fetchPublishedManifest(
    '@ophis/agent-swap',
    'https://registry.npmjs.org/%40ophis%2Fagent-swap',
    adapterPackages[0].version,
  ),
  fetchPublishedManifest(
    '@ophis/agentkit-ophis',
    'https://registry.npmjs.org/%40ophis%2Fagentkit-ophis',
    adapterPackages[1].version,
  ),
  fetchPublishedManifest(
    '@ophis/plugin-goat',
    'https://registry.npmjs.org/%40ophis%2Fplugin-goat',
    adapterPackages[2].version,
  ),
  fetchPublishedManifest(
    '@ophis/plugin-elizaos',
    'https://registry.npmjs.org/%40ophis%2Fplugin-elizaos',
    adapterPackages[3].version,
  ),
  fetchPublishedManifest(
    '@ophis/agent-skills',
    'https://registry.npmjs.org/%40ophis%2Fagent-skills',
    skillsPackage.version,
  ),
]);

for (const [index, manifest] of packages.entries()) {
  const published = publishedPackages[index];
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
