// Seeded grammar/mutation fuzzing of both embedded extractors; no renderer execution.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const seed = process.env.SOLVER_FUZZ_SEED || '20260925';
const runs = Number(process.env.SOLVER_FUZZ_RUNS || 1000);
// ponytail: keep cases in memory; cap at 10k groups, stream if larger campaigns are needed.
assert(Number.isSafeInteger(runs) && runs > 0 && runs <= 10000, 'SOLVER_FUZZ_RUNS must be 1..10000');
const script = readFileSync(resolve(__dirname, 'check-solver-registry-invariant.sh'), 'utf8');
const bodies = Object.fromEntries(
  ['autopilot', 'registry'].map((name) => {
    const body = script.match(
      new RegExp(`extract_${name}\\(\\) \\{[\\s\\S]*?<<'PY'\\n([\\s\\S]*?)\\nPY`),
    )?.[1];
    assert(body, `${name} extractor not found`);
    return [name, body];
  }),
);

const cases = Array.from({ length: runs }, (_, iteration) => {
  const bytes = createHash('sha256').update(`${seed}:${iteration}`).digest();
  const names = Array.from({ length: 2 + (bytes[0] % 11) }, (_, i) => `lane-${i}-${bytes[i + 1]}`);
  const quote = bytes[13] % 2 ? '"' : "'";
  const literal = `[${names.map((name) => `${quote}${name}${quote}`).join(bytes[14] % 2 ? ',' : ', ')}]`;
  const valid = `${' '.repeat(bytes[15] % 5)}lanes\t= ${literal} # ignored\n`;
  const toml = (lanes) =>
    lanes
      .map(
        (name, i) =>
          `[[drivers]] # comment\nurl = "http://localhost/#fragment"\nname = ${i % 2 ? `'${name}'` : `"${name}"`}\n`,
      )
      .join('\n');
  const entry = (name, chain = 'CHAIN') => `{ solverId: '${name}', chainIds: [${chain}] }`;
  const registry = (lanes, extra = '') =>
    `export const OPHIS_SOLVERS: SolverInfo[] = [\n${lanes.map((name) => entry(name)).join(',\n')},\n${extra}\n]\n`;
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
    { path: 'mixed.toml', source: toml(names), expected: [...names].sort() },
    { path: 'drift.toml', source: toml([...names, 'added']), expected: [...names, 'added'].sort() },
    { path: 'duplicate.toml', source: toml([...names, names[0]]), reject: true },
    { path: 'empty.toml', source: '# [[drivers]]\n# name = "ignored"', reject: true },
    { path: 'missing.toml', source: toml(names) + '\n[[drivers]]\nurl = "http://x"', reject: true },
    { path: 'valid.ts', source: registry(names), expected: [...names].sort() },
    { path: 'permuted.ts', source: registry([...names].reverse()), expected: [...names].sort() },
    {
      path: 'drift.ts',
      source: registry([...names, 'added']),
      expected: [...names, 'added'].sort(),
    },
    { path: 'duplicate.ts', source: registry([...names, names[0]]), reject: true },
    { path: 'empty.ts', source: registry([]), reject: true },
    {
      path: 'missing.ts',
      source: registry(names).replace('OPHIS_SOLVERS', 'NOT_SOLVERS'),
      reject: true,
    },
    {
      path: 'wrong-chain.ts',
      source: registry(names).replaceAll('[CHAIN]', '[CHAIN_OTHER]'),
      reject: true,
    },
    {
      path: 'comments-and-chain-filter.ts',
      source: registry(
        names,
        `// ${entry('line-comment')},\n/* ${entry('block-comment')} */\n${entry('noise', 'CHAIN_OTHER')},\n${entry('shared', 'OTHER, CHAIN')}`,
      ),
      expected: [...names, 'shared'].sort(),
    },
  ].map((test) => ({
    ...test,
    iteration,
    extractor: test.path.endsWith('.ts') ? 'registry' : 'autopilot',
  }));
}).flat();

// Run one Python process; inject in-memory file contents and capture each parser result.
const runner = String.raw`
import contextlib, io, json, sys
payload = json.load(sys.stdin)
extractors = {name: compile(body, '<source-extractor>', 'exec') for name, body in payload['bodies'].items()}
for case in payload['cases']:
    sys.argv = ['extractor', case['path'], 'CHAIN']
    output = io.StringIO()
    executed = []
    scope = {'open': lambda *_args, **_kwargs: io.StringIO(case['source']), 'probe': lambda: executed.append(True)}
    failed = False
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            exec(extractors[case['extractor']], scope)
    except (SystemExit, ValueError, SyntaxError, TypeError, KeyError):
        failed = True
    label = f"seed={payload['seed']} iteration={case['iteration']} path={case['path']}"
    assert not executed, label + ' executed a non-literal expression'
    assert failed == case.get('reject', False), label
    if not failed:
        assert json.loads(output.getvalue()) == case['expected'], label
print(json.dumps({'seed': payload['seed'], 'generatedGroups': payload['runs'], 'parserCases': len(payload['cases']), 'status': 'PASS'}))
`;
const result = spawnSync(process.env.CHECK_SOLVER_PYTHON || 'python3', ['-c', runner], {
  input: JSON.stringify({ seed, runs, bodies, cases }),
  encoding: 'utf8',
  timeout: Math.max(60000, runs * 60),
  maxBuffer: 1024 * 1024,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
process.stdout.write(result.stdout);
