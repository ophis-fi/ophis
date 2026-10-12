#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

if (require.main === module && process.argv[2] !== '--worker') {
  const result = spawnSync(process.execPath, [__filename, '--worker', ...process.argv.slice(2)], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

// Also callable against an isolated fixture: node this-file /fixture/package.json.
async function testStreamJson(requirePackage) {
  const { parser } = requirePackage('stream-json');
  const Assembler = requirePackage('stream-json/Assembler');
  const { streamValues } = requirePackage('stream-json/streamers/StreamValues');
  const { streamArray } = requirePackage('stream-json/streamers/StreamArray');
  const { streamObject } = requirePackage('stream-json/streamers/StreamObject');
  const Verifier = requirePackage('stream-json/utils/Verifier');
  async function collect(input, ...transforms) {
    const output = [];
    await pipeline(Readable.from([input]), parser(), ...transforms, new Writable({
      objectMode: true,
      write(chunk, _, callback) { output.push(chunk); callback(); },
    }));
    return output;
  }
  async function values(input, filter) {
    return (await collect(input, ...(filter ? [filter] : []), streamValues())).map(({ value }) => value);
  }
  async function assembled(input, options) {
    const tokens = parser();
    const assembler = Assembler.connectTo(tokens, options);
    const results = [];
    assembler.on('done', ({ current }) => results.push(current));
    await pipeline(Readable.from([input]), tokens, new Writable({
      objectMode: true, write(_chunk, _encoding, callback) { callback(); },
    }));
    assert.equal(results.length, 1, 'legacy Assembler done event must remain supported');
    return results[0];
  }
  function parity(actual, expected) {
    assert.deepEqual(actual, expected);
    if (actual === null || typeof actual !== 'object') return;
    assert.equal(Object.getPrototypeOf(actual), Object.getPrototypeOf(expected));
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
    for (const key of Object.keys(expected)) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(actual, key), Object.getOwnPropertyDescriptor(expected, key));
      parity(actual[key], expected[key]);
    }
  }

  // GHSA-mjw6-4jj6-33hc: inherited __proto__ setters must never run. Check both
  // save paths and every public streamer, including null/array/duplicate keys.
  const vectors = [
    '{"__proto__":{"isAdmin":true,"role":"superuser"},"name":"bob"}',
    '{"__proto__":null,"name":"bob"}',
    '{"__proto__":["isAdmin","role"],"name":"bob"}',
    '{"__proto__":"text","name":"bob"}',
    '{"__proto__":{"hasOwnProperty":1},"name":"bob"}',
    '{"user":{"__proto__":{"isAdmin":true},"name":"alice"}}',
    '{"constructor":{"prototype":{"isAdmin":true}},"name":"bob"}',
    '{"__proto__":{"first":true},"name":"bob","__proto__":{"last":true}}',
    '{"__proto__":0,"__proto__":false,"__proto__":true}',
  ];
  for (const input of vectors) {
    const expected = JSON.parse(input);
    parity((await values(input))[0], expected);
    parity(await assembled(input), expected);
    parity(await assembled(input, { reviver: (_key, value) => value }), expected);
    parity((await collect(`[${input}]`, streamArray()))[0].value, expected);
    parity((await collect(`{"item":${input}}`, streamObject()))[0], { key: 'item', value: expected });
  }
  for (const value of ['null', '{"isAdmin":true}', '[1,2]', '"text"', '42', 'false']) {
    const input = `{"__proto__":${value},"ordinary":1}`;
    parity(Object.fromEntries((await collect(input, streamObject())).map(({ key, value }) => [key, value])), JSON.parse(input));
  }
  const reviverInput = '{"__proto__":{"n":2},"keep":3,"remove":4}';
  for (const reviver of [
    (key, value) => key === 'remove' ? undefined : typeof value === 'number' ? value * 2 : value,
    (key, value) => key === '__proto__' ? undefined : value,
  ]) {
    parity(await assembled(reviverInput, { reviver }), JSON.parse(reviverInput, reviver));
  }
  parity(await assembled('{"__proto__":123,"n":456}', { numberAsString: true }), JSON.parse('{"__proto__":"123","n":"456"}'));
  assert.equal(Object.prototype.isAdmin, undefined);
  assert.equal(({}).role, undefined);

  const input = JSON.stringify({ keep: { n: 1 }, drop: [2, 3] });
  const cases = [
    ['Filter', 'keep', { keep: { n: 1 } }],
    ['Pick', 'keep', { n: 1 }],
    ['Replace', 'drop', { keep: { n: 1 }, drop: null }],
    ['Ignore', 'drop', { keep: { n: 1 } }],
  ];
  for (const [name, filter, expected] of cases) {
    const Filter = requirePackage(`stream-json/filters/${name}`);
    assert.deepEqual(await values(input, new Filter({ filter })), [expected]);
    // GHSA-528h-pc64-c93x: force path traversal rather than subtree pass/skip.
    for (const [open, close] of [['{"a":', '}'], ['[', ']']]) {
      const deep = open.repeat(8192) + '0' + close.repeat(8192);
      await assert.rejects(values(deep, new Filter({ filter: 'missing' })), {
        name: 'RangeError', message: /JSON nesting exceeds 1024 levels/,
      });
    }
  }
  assert.deepEqual(await values(input), [JSON.parse(input)]);

  // GHSA-hqr4-qq8f-hg3x affects JSONC modules absent from v1.9.1. Its plain
  // parser/verifier reject comments rather than buffering a comment scanner.
  for (const entry of ['stream-json/jsonc/Parser.js', 'stream-json/jsonc/parser.js', 'stream-json/jsonc/verifier.js']) {
    assert.throws(() => requirePackage.resolve(entry), { code: 'MODULE_NOT_FOUND' });
  }
  for (const comment of ['/* comment */1', '// comment\n1']) {
    await assert.rejects(values(comment), /Parser/);
    await assert.rejects(pipeline(Readable.from([comment]), new Verifier()), /Verifier/);
  }
  return requirePackage('stream-json/package.json').version;
}

module.exports = testStreamJson;

if (require.main === module) {
  testStreamJson(createRequire(resolve(process.argv[3] || 'package.json')))
    .then((version) => console.log(`PASS stream-json ${version}: prototype parity, reviver, streamers, depth guards and JSONC exclusion`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
