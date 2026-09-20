// Exercise pnpm's filtered publish without credentials, network access or a real npm publish.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflows = ['agent-plugins', 'safe-swap', 'sdk', 'widget', 'skills'];
let publishSteps = 0;
for (const workflow of workflows) {
  const source = readFileSync(
    new URL(`../.github/workflows/${workflow}-release.yml`, import.meta.url),
    'utf8',
  );
  for (const step of source.split('\n      - ')) {
    if (!/run: pnpm .* publish /.test(step)) continue;
    assert.match(step, /NPM_CONFIG_PROVENANCE: 'true'/, `${workflow} must enable npm provenance`);
    publishSteps++;
  }
}
assert.equal(publishSteps, 8);

const directory = mkdtempSync(join(tmpdir(), 'ophis-provenance-'));
try {
  // Pin the same pnpm version as the repo, even when invoked through Corepack outside the repo.
  const { packageManager } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'ophis-provenance-fixture', version: '0.0.0', packageManager }),
  );
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), "packages: ['.']\n");
  const npm = join(directory, 'npm.cjs');
  writeFileSync(
    npm,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'npm-call.json'), JSON.stringify({
  args: process.argv.slice(2), provenance: process.env.NPM_CONFIG_PROVENANCE
}));
`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      'ophis-provenance-fixture',
      'publish',
      '--no-git-checks',
      '--access',
      'public',
      '--provenance',
      '--ignore-scripts',
      '--force',
      '--dry-run',
      `--npm-path=${npm}`,
      '--registry=http://127.0.0.1:1',
    ],
    {
      cwd: directory,
      // No inherited auth/config: the replacement npm only records the invocation locally.
      env: {
        PATH: process.env.PATH,
        // action-setup caches the pinned pnpm here; retain its location to avoid a download.
        ...(process.env.PNPM_HOME ? { PNPM_HOME: process.env.PNPM_HOME } : {}),
        NPM_CONFIG_PROVENANCE: 'true',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `${result.error ?? ''}${result.stdout}${result.stderr}`);
  const call = JSON.parse(readFileSync(join(directory, 'npm-call.json')));
  assert.equal(call.args[0], 'publish');
  assert.ok(call.args.includes('--dry-run'));
  assert.equal(call.provenance, 'true', 'npm must receive provenance through pnpm');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log('OK: all eight release steps enable provenance; filtered pnpm publish preserves it.');
