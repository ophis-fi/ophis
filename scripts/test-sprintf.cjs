#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

// A subprocess bounds synchronous failures; precision payloads produce at most 100 digits.
if (process.argv[2] !== '--worker') {
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', __filename, '--worker', ...process.argv.slice(2)], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { test } = require('node:test');
const workspace = resolve(process.argv[3] || resolve(__dirname, '../apps/frontend'));
const hoisted = createRequire(resolve(workspace, 'node_modules/.pnpm/node_modules/_sprintf-check.cjs'));
const rushstack = createRequire(hoisted.resolve('@rushstack/ts-command-line'));
const argparse = createRequire(rushstack.resolve('argparse'));
const sprintfPackage = createRequire(argparse.resolve('sprintf-js'));

for (const entry of ['sprintf-js', 'sprintf-js/dist/sprintf.min.js']) {
  const { sprintf, vsprintf } = sprintfPackage(entry);
  test(`${entry}: cap numeric precision, including zero and overflow, without changing valid output`, () => {
    for (const kind of ['e', 'f', 'g']) {
      for (const precision of ['0', '1', '2', '20', '100', '101', '1000000', '9'.repeat(10000)]) {
        const bound = Math.min(100, Math.max(kind === 'g' ? 1 : 0, Number(precision)));
        const expected = kind === 'e' ? (1.25).toExponential(bound)
          : kind === 'f' ? (1.25).toFixed(bound) : (1.25).toPrecision(bound);
        assert.equal(sprintf(`%.${precision}${kind}`, 1.25), expected);
        assert.equal(vsprintf(`%.${precision}${kind}`, [1.25]), expected);
      }
    }
    assert.equal(sprintf('%.150s', 'a'.repeat(200)), 'a'.repeat(150));
    assert.equal(sprintf('%.0s', 'hello'), '');
    assert.equal(sprintf('%e|%f|%g', 1.25, 1.25, 1.25), '1.25e+0|1.25|1.25');
    assert.equal(sprintf('%+08.2f', 1.25), '+0001.25');
    assert.equal(sprintf('%2$s:%1$d', 7, 'Ophis'), 'Ophis:7');
    assert.equal(sprintf('%(user.name)s', { user: { name: 'Ophis' } }), 'Ophis');
    assert.equal(sprintf('%j', { count: 7 }), '{"count":7}');
    assert.equal(sprintf('%04x %%', 10), '000a %');
  });

  test(`${entry}: public format and cached parse trees retain the precision guard`, () => {
    const tree = sprintf.parse('%.2f');
    tree[0][7] = '1000000';
    assert.equal(sprintf.format(tree, ['unused', 1]), (1).toFixed(100));
    sprintf.cache['cached %.2f'] = ['cached ', tree[0]];
    assert.equal(sprintf('cached %.2f', 1), 'cached ' + (1).toFixed(100));
  });
}

test('argparse and Rushstack retain help, flags, values, subcommands and error handling', async () => {
  const { ArgumentParser } = rushstack('argparse');
  const parser = new ArgumentParser({ prog: 'fixture', addHelp: false, debug: true,
    description: 'Run %(prog)s', epilog: 'End %(prog)s' });
  parser.addArgument('--count', { type: 'int', defaultValue: 3, help: 'count %(defaultValue)s' });
  assert.equal(parser.parseArgs(['--count', '7']).count, 7);
  assert.match(parser.formatHelp(), /Run fixture/);
  assert.match(parser.formatHelp(), /count 3/);
  assert.match(parser.formatHelp(), /End fixture/);
  assert.throws(() => parser.parseArgs(['--unknown']), /[Uu]nrecognized arguments/);

  const { CommandLineParser, CommandLineAction } = hoisted('@rushstack/ts-command-line');
  const command = new CommandLineParser({ toolFilename: 'fixture', toolDescription: 'fixture' });
  const action = new CommandLineAction({ actionName: 'build', summary: 'Build', documentation: 'Build docs' });
  const flag = action.defineFlagParameter({ parameterLongName: '--verbose', description: 'Verbose' });
  const count = action.defineIntegerParameter({ parameterLongName: '--count', argumentName: 'COUNT', description: 'Count' });
  let executed = false;
  action.onExecuteAsync = async () => { executed = true; };
  command.addAction(action);
  await command.executeWithoutErrorHandlingAsync(['build', '--verbose', '--count', '7']);
  assert(executed && flag.value);
  assert.equal(count.value, 7);
  assert.match(command.renderHelpText(), /build/);
  const invalid = new CommandLineParser({ toolFilename: 'fixture', toolDescription: 'fixture' });
  await assert.rejects(invalid.executeWithoutErrorHandlingAsync(['--unknown']), error => error.exitCode === 2);
});
