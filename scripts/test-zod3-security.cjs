#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

// Also callable against an isolated fixture: node this-file /fixture/package.json.
// GHSA-mrhx-c7xc-m3w5 backport (patches/zod@3.*.patch): an array over .max()/.length()
// or a set over .max()/.size() fails on its size issue before any element is parsed.
async function testZod3(requirePackage) {
  const { z } = requirePackage('zod');
  let calls = 0;
  const spy = () => { calls += 1; return true; };
  const tooBig = (maximum, type, exact, message) => ({
    code: 'too_big', maximum, type, inclusive: true, exact, message, path: [],
  });
  const arrayMax = tooBig(3, 'array', false, 'Array must contain at most 3 element(s)');
  // .length() issues carry an explicit minimum: undefined; keep that shape.
  const arrayExact = { ...tooBig(3, 'array', true, 'Array must contain exactly 3 element(s)'), minimum: undefined };
  const setMax = tooBig(2, 'set', false, 'Invalid input'); // zod 3's default map has no set text

  async function rejects(schema, input, issues) {
    for (const parse of [(s, v) => s.safeParse(v), (s, v) => s.safeParseAsync(v)]) {
      calls = 0;
      const result = await parse(schema, input);
      assert.equal(result.success, false);
      assert.deepEqual(result.error.issues, issues);
      assert.equal(calls, 0, 'no element may be parsed once the size bound fails');
    }
  }
  async function accepts(schema, input, parsed) {
    for (const parse of [(s, v) => s.parse(v), (s, v) => s.parseAsync(v)]) {
      calls = 0;
      assert.deepEqual(await parse(schema, input), parsed);
      assert.equal(calls, parsed.length ?? parsed.size);
    }
  }

  const refined = z.number().refine(spy);
  const transformed = z.number().transform((n) => (spy(), n * 2));
  const asyncRefined = z.number().refine(async () => spy());
  for (const element of [refined, transformed]) {
    await rejects(z.array(element).max(3), [1, 2, 3, 4], [arrayMax]);
    await rejects(z.array(element).length(3), [1, 2, 3, 4], [arrayExact]);
    await rejects(z.array(element).max(2).length(3), [1, 2, 3, 4],
      [arrayExact, tooBig(2, 'array', false, 'Array must contain at most 2 element(s)')]);
    await rejects(z.set(element).max(2), new Set([1, 2, 3]), [setMax]);
    await rejects(z.set(element).size(2), new Set([1, 2, 3]), [setMax]);
    const expected = element === transformed ? [2, 4, 6] : [1, 2, 3];
    await accepts(z.array(element).max(3), [1, 2, 3], expected);
    await accepts(z.array(element).length(3), [1, 2, 3], expected);
    await accepts(z.set(element).size(3), new Set([1, 2, 3]), new Set(expected));
  }
  calls = 0;
  const asyncResult = await z.array(asyncRefined).max(3).safeParseAsync([1, 2, 3, 4]);
  assert.deepEqual(asyncResult.error.issues, [arrayMax]);
  assert.equal(calls, 0);
  calls = 0;
  const asyncSet = await z.set(asyncRefined).max(2).safeParseAsync(new Set([1, 2, 3]));
  assert.deepEqual(asyncSet.error.issues, [setMax]);
  assert.equal(calls, 0);
  calls = 0;
  assert.deepEqual(await z.array(asyncRefined).max(3).parseAsync([1, 2, 3]), [1, 2, 3]);
  assert.equal(calls, 3);

  // The advisory's memory blow-up: one issue, not one per bad element.
  const flood = z.array(z.number()).max(10).safeParse(new Array(100_000).fill('x'));
  assert.deepEqual(flood.error.issues, [tooBig(10, 'array', false, 'Array must contain at most 10 element(s)')]);
  const nested = z.object({ list: z.array(refined).max(1) }).safeParse({ list: [1, 2] });
  assert.deepEqual(nested.error.issues, [{ ...tooBig(1, 'array', false, 'Array must contain at most 1 element(s)'), path: ['list'] }]);

  // Unchanged outside the bound: a short array still parses every element and
  // reports their issues next to the min/exact issue.
  calls = 0;
  const short = z.array(refined).length(3).safeParse([1, 'a']);
  assert.deepEqual(short.error.issues.map(({ code, path }) => [code, path]), [['too_small', []], ['invalid_type', [1]]]);
  assert.equal(calls, 1);
  const within = z.array(z.number()).max(3).safeParse([1, 'a']);
  assert.deepEqual(within.error.issues.map(({ code, path }) => [code, path]), [['invalid_type', [1]]]);
  const minimum = z.set(z.number()).min(2).safeParse(new Set(['a']));
  assert.deepEqual(minimum.error.issues.map(({ code, path }) => [code, path]), [['too_small', []], ['invalid_type', [0]]]);
  return requirePackage('zod/package.json').version;
}

module.exports = testZod3;

if (require.main === module) {
  testZod3(createRequire(resolve(process.argv[2] || 'package.json')))
    .then((version) => console.log(`PASS zod ${version}: oversized arrays/sets fail before element parsing; in-bound parsing unchanged`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
