#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

// A child process bounds regressions that block the regex engine synchronously.
if (process.argv[2] !== '--worker') {
  const result = spawnSync(process.execPath, [__filename, '--worker', ...process.argv.slice(2)], {
    timeout: 10_000, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

for (const project of process.argv.slice(3)) {
  const root = resolve(project);
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const store = join(root, 'node_modules/.pnpm');
  const installedLock = readFileSync(join(store, 'lock.yaml'), 'utf8');
  const patches = new Map(Array.from(installedLock.matchAll(/^  picomatch@(\S+):\n    hash: (\S+)$/gm),
    ([, version, hash]) => [version, hash]));
  const versions = new Set(Array.from(lock.matchAll(/^  ['"]?picomatch@([0-9.]+)[^:\n]*:/gm), ([, version]) => version));
  assert(versions.size, `No picomatch copies found in ${project}`);
  for (const version of versions) {
    const hash = patches.get(version);
    assert(hash, `Missing installed picomatch@${version} patch in ${project}`);
    const entry = readdirSync(store).find(name => name.startsWith(`picomatch@${version}_`) && name.includes(`patch_hash=${hash}`));
    assert(entry, `Missing active picomatch@${version} install in ${project}`);
    const picomatch = require(join(store, entry, 'node_modules/picomatch'));
    for (const pattern of ['+(*)z', '+(*a)z', '*(*)z', '*(*a)z', '+(**a)z', '+(@(*a))z']) {
      const match = picomatch(pattern);
      assert.equal(match('a'.repeat(32) + '!'), false, pattern);
      assert.equal(match(pattern), true, `Unsafe repeated glob must be literal: ${pattern}`);
    }
    for (const [pattern, input, expected] of [
      ['**/*.js', 'lib/index.js', true], ['**/*.js', 'lib/index.ts', false],
      ['@(a|b).js', 'a.js', true], ['+(ab|cd)', 'abcdab', true],
      ['+([ab])', 'abba', true], ['+(\\*)', '***', true],
      ['!(*.d).ts', 'index.ts', true], ['!(*.d).ts', 'index.d.ts', false],
      ['+(*(a))', 'aaaa', true],
    ]) assert.equal(picomatch(pattern)(input), expected, `${pattern}: ${input}`);
    console.log(`${project}: picomatch@${version} security and compatibility checks passed`);
  }
}
assert(process.argv.length > 3, 'Supply at least one project directory');
