// Seeded grammar/mutation fuzzing of the actual embedded extractor; no renderer execution.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const seed = process.env.SOLVER_FUZZ_SEED || '20260925';
const runs = Number(process.env.SOLVER_FUZZ_RUNS || 1000);
assert(Number.isSafeInteger(runs) && runs > 0 && runs <= 100000);
const script = readFileSync(resolve(__dirname, 'check-solver-registry-invariant.sh'), 'utf8');
const body = script.match(/extract_autopilot\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1];
assert(body, 'source extractor not found');

const cases = Array.from({ length: runs }, (_, iteration) => {
  const bytes = createHash('sha256').update(`${seed}:${iteration}`).digest();
  const names = Array.from({ length: 1 + (bytes[0] % 12) }, (_, i) => `lane-${i}-${bytes[i + 1]}`);
  const quote = bytes[13] % 2 ? '"' : "'";
  const literal = `[${names.map((name) => `${quote}${name}${quote}`).join(bytes[14] % 2 ? ',' : ', ')}]`;
  const valid = `${' '.repeat(bytes[15] % 5)}lanes\t= ${literal} # ignored\n`;
  return [
    { path: 'valid.py', source: valid, expected: [...names].sort() },
    {
      path: 'permuted.py',
      source: `lanes = ${JSON.stringify([...names].reverse())}`,
      expected: [...names].sort(),
    },
    {
      path: 'drift.py',
      source: `lanes = ${JSON.stringify([...names, 'added'])}`,
      expected: [...names, 'added'].sort(),
    },
    {
      path: 'duplicate.py',
      source: `lanes = ${JSON.stringify([...names, names[0]])}`,
      reject: true,
    },
    { path: 'missing.py', source: valid.replace('lanes', 'not_lanes'), reject: true },
    { path: 'expression.py', source: 'lanes = [probe()]', reject: true },
    { path: 'empty.py', source: 'lanes = []', reject: true },
    {
      path: 'valid.toml',
      source: names.map((name) => `[[drivers]]\nname = "${name}"\n`).join('\n'),
      expected: [...names].sort(),
    },
  ].map((test) => ({ ...test, iteration }));
}).flat();

// Run one Python process; inject in-memory file contents and capture each parser result.
const runner = String.raw`
import contextlib, io, json, sys
payload = json.load(sys.stdin)
extractor = compile(payload['body'], '<source-extractor>', 'exec')
for case in payload['cases']:
    sys.argv = ['extractor', case['path']]
    output = io.StringIO()
    executed = []
    scope = {'open': lambda *_args, **_kwargs: io.StringIO(case['source']), 'probe': lambda: executed.append(True)}
    failed = False
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            exec(extractor, scope)
    except (SystemExit, ValueError, SyntaxError, TypeError):
        failed = True
    label = f"seed={payload['seed']} iteration={case['iteration']} path={case['path']}"
    assert not executed, label + ' executed a non-literal expression'
    assert failed == case.get('reject', False), label
    if not failed:
        assert json.loads(output.getvalue()) == case['expected'], label
print(json.dumps({'seed': payload['seed'], 'generatedGroups': len(payload['cases']) // 8, 'parserCases': len(payload['cases']), 'status': 'PASS'}))
`;
const result = spawnSync(process.env.CHECK_SOLVER_PYTHON || 'python3', ['-c', runner], {
  input: JSON.stringify({ seed, body, cases }),
  encoding: 'utf8',
  timeout: 60000,
  maxBuffer: 1024 * 1024,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
process.stdout.write(result.stdout);
