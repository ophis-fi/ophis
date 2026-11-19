// Exercise release publish commands without credentials, network access or a real npm publish.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflows = ['agent-plugins', 'safe-swap', 'sdk', 'widget', 'skills', 'cli'];
let publishSteps = 0;
let cliPublishArgs;
for (const workflow of workflows) {
  const source = readFileSync(
    new URL(`../.github/workflows/${workflow}-release.yml`, import.meta.url),
    'utf8',
  );
  for (const step of source.split('\n      - ')) {
    if (!/run: pnpm (?:.* )?publish /.test(step)) continue;
    assert.match(step, /NPM_CONFIG_PROVENANCE: 'true'/, `${workflow} must enable npm provenance`);
    if (workflow === 'cli') {
      assert.match(step, /working-directory: packages\/cli\/dist\/npm/);
      cliPublishArgs = step
        .match(/run: pnpm (.+)/)[1]
        .trim()
        .split(/\s+/);
    }
    publishSteps++;
  }
}
assert.equal(publishSteps, 9);
assert.ok(cliPublishArgs);

const directory = mkdtempSync(join(tmpdir(), 'ophis-provenance-'));
try {
  // Reuse the exact CLI running this script; a shim may download pnpm again outside the repo.
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm, 'Run this check with pnpm test:release-provenance');
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'ophis-provenance-fixture', version: '0.0.0' }),
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
  for (const args of [
    [
      '--filter',
      'ophis-provenance-fixture',
      'publish',
      '--no-git-checks',
      '--access',
      'public',
      '--provenance',
      '--ignore-scripts',
    ],
    cliPublishArgs,
  ]) {
    const result = spawnSync(
      process.execPath,
      [pnpm, ...args, '--force', '--dry-run', `--npm-path=${npm}`, '--registry=http://127.0.0.1:1'],
      {
        cwd: directory,
        // No inherited auth/config: the replacement npm only records the invocation locally.
        env: { PATH: process.env.PATH, NPM_CONFIG_PROVENANCE: 'true' },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 0, `${result.error ?? ''}${result.stdout}${result.stderr}`);
    const call = JSON.parse(readFileSync(join(directory, 'npm-call.json')));
    assert.equal(call.args[0], 'publish');
    assert.equal(
      call.args.filter((arg) => arg === 'publish').length,
      1,
      'pnpm must not forward duplicate publish arguments',
    );
    assert.ok(call.args.includes('--dry-run'));
    assert.equal(call.provenance, 'true', 'npm must receive provenance through pnpm');
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(
  'OK: all nine release steps enable provenance; filtered and staged CLI publishes preserve it.',
);
