#!/usr/bin/env node
// Pack the four @ophis agent adapters exactly as the release workflow will and
// prove pnpm resolved every workspace dependency to the reviewed public version.
// This prevents source/tests from passing against the workspace SDK while the
// npm artifact remains pinned to an obsolete SDK release.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK_PACKAGE = 'packages/sdk/package.json';
const PACKAGES = [
  {
    directory: 'packages/agent-swap',
    name: '@ophis/agent-swap',
    dependency: ['@ophis/sdk', 'sdk'],
  },
  {
    directory: 'packages/plugin-goat',
    name: '@ophis/plugin-goat',
    dependency: ['@ophis/agent-swap', 'adapter'],
  },
  {
    directory: 'packages/agentkit-ophis',
    name: '@ophis/agentkit-ophis',
    dependency: ['@ophis/agent-swap', 'adapter'],
  },
  {
    directory: 'packages/plugin-elizaos',
    name: '@ophis/plugin-elizaos',
    dependency: ['@ophis/agent-swap', 'adapter'],
  },
];

const readJson = (relativePath) => JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
const sdkVersion = readJson(SDK_PACKAGE).version;
const sourceManifests = PACKAGES.map((entry) => ({
  ...entry,
  manifest: readJson(`${entry.directory}/package.json`),
}));
const adapterVersions = new Set(sourceManifests.map(({ manifest }) => manifest.version));

if (adapterVersions.size !== 1) {
  console.error(
    `verify-agent-plugin-release: adapter versions differ: ${[...adapterVersions].join(', ')}`,
  );
  process.exit(1);
}

const adapterVersion = sourceManifests[0].manifest.version;
const packDirectory = mkdtempSync(join(tmpdir(), 'ophis-agent-plugin-packs-'));

try {
  for (const entry of sourceManifests) {
    const packed = spawnSync('pnpm', ['pack', '--pack-destination', packDirectory], {
      cwd: join(REPO_ROOT, entry.directory),
      encoding: 'utf8',
    });
    if (packed.status !== 0 || packed.error) {
      console.error(
        `verify-agent-plugin-release: failed to pack ${entry.name}:\n` +
          `${packed.stdout ?? ''}${packed.stderr ?? ''}${packed.error ?? ''}`,
      );
      process.exit(1);
    }

    const archiveName = `${entry.name.slice(1).replace('/', '-')}-${adapterVersion}.tgz`;
    const archivePath = join(packDirectory, archiveName);
    if (!existsSync(archivePath)) {
      console.error(`verify-agent-plugin-release: expected tarball not found: ${archivePath}`);
      process.exit(1);
    }

    const extracted = spawnSync('tar', ['-xOf', archivePath, 'package/package.json'], {
      encoding: 'utf8',
    });
    if (extracted.status !== 0 || extracted.error) {
      console.error(
        `verify-agent-plugin-release: could not read ${entry.name} package.json from tarball:\n` +
          `${extracted.stdout ?? ''}${extracted.stderr ?? ''}${extracted.error ?? ''}`,
      );
      process.exit(1);
    }

    const manifest = JSON.parse(extracted.stdout);
    if (manifest.name !== entry.name || manifest.version !== adapterVersion) {
      console.error(
        `verify-agent-plugin-release: packed identity ${manifest.name}@${manifest.version} ` +
          `!= ${entry.name}@${adapterVersion}`,
      );
      process.exit(1);
    }

    const [dependencyName, versionSource] = entry.dependency;
    const expectedVersion = versionSource === 'sdk' ? sdkVersion : adapterVersion;
    const actualVersion = manifest.dependencies?.[dependencyName];
    if (actualVersion !== expectedVersion) {
      console.error(
        `verify-agent-plugin-release: ${entry.name} packs ${dependencyName}@${actualVersion ?? '(missing)'}; ` +
          `expected ${expectedVersion}`,
      );
      process.exit(1);
    }

    for (const dependencies of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [name, version] of Object.entries(dependencies ?? {})) {
        if (String(version).startsWith('workspace:')) {
          console.error(
            `verify-agent-plugin-release: ${entry.name} leaves ${name}@${version} unresolved`,
          );
          process.exit(1);
        }
      }
    }
  }
} finally {
  rmSync(packDirectory, { recursive: true, force: true });
}

console.log(
  `OK: four adapter tarballs are ${adapterVersion}; @ophis/agent-swap pins @ophis/sdk ${sdkVersion}; ` +
    `all framework adapters pin @ophis/agent-swap ${adapterVersion}.`,
);
