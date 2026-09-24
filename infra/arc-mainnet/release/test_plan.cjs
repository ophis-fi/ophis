// Offline release-state regression; only temporary fixture files are written.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { writePlan, checkActivation, assertNewPlan } = require('./plan.cjs')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-plan-state-'))
try {
  const config = { ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'))),
    solver: '0x1111111111111111111111111111111111111111', nonce: 42 }
  const artifacts = Object.fromEntries(['ArcDisabledVault', 'Balances', 'Signatures'].map(name => [name, { abi: [], bytecode: '0x6000' }]))
  artifacts.GPv2AllowListAuthentication = { abi: ['function initializeManager(address)', 'function addSolver(address)'], bytecode: '0x6000' }
  artifacts.EIP173Proxy = { abi: ['constructor(address,address,bytes)'], bytecode: '0x6000' }
  artifacts.GPv2Settlement = { abi: ['constructor(address,address)'], bytecode: '0x6000' }
  artifacts.HooksTrampoline = { abi: ['constructor(address)'], bytecode: '0x6000' }
  const output = path.join(directory, 'prepared')
  const built = { input: {}, artifacts }
  const plan = writePlan(config, built, output)
  const batch = JSON.parse(fs.readFileSync(path.join(output, 'safe-activation.json')))
  checkActivation(plan, batch)
  for (const changed of [
    { ...batch, chainId: '1' },
    { ...batch, meta: { ...batch.meta, createdFromSafeAddress: config.solver } },
    { ...batch, transactions: [{ ...plan.safeTransaction, data: '0xdeadbeef' }] },
    { ...batch, transactions: [...batch.transactions, plan.safeTransaction] },
  ]) assert.throws(() => checkActivation(plan, changed))
  const snapshots = Object.fromEntries(fs.readdirSync(output).map(name => [name, fs.readFileSync(path.join(output, name))]))
  assert.throws(() => writePlan({ ...config, nonce: 43 }, built, output), /Existing release state/)
  for (const [name, bytes] of Object.entries(snapshots)) assert.deepEqual(fs.readFileSync(path.join(output, name)), bytes)
  for (const name of ['receipts', 'verified', 'activation', 'artifacts', 'solc-input', 'safe-activation']) {
    const occupied = path.join(directory, name)
    fs.mkdirSync(occupied)
    fs.writeFileSync(path.join(occupied, name + '.json'), '{}')
    assert.throws(() => assertNewPlan(occupied), /Existing release state/)
  }
  // Both preview entry points must refuse before RPC, Docker, or secret writes.
  const script = `import json,pathlib,runpy,tempfile
for file,function in [('check.py','main'),('render.py','render')]:
 scope=runpy.run_path(str(pathlib.Path(${JSON.stringify(__dirname)})/file),run_name='arc_check_test')
 for name,value in [('receipts.json',[]),('verified.json',{}),('activation.json',{'active':True})]:
  with tempfile.TemporaryDirectory() as directory:
   out=pathlib.Path(directory); (out/name).write_text(json.dumps(value))
   scope[function].__globals__['OUT']=out
   try: scope[function]()
   except AssertionError as error: assert 'Refusing to' in str(error)
   else: raise AssertionError('preview modified deployed state')
   assert [p.name for p in out.iterdir()]==[name]
# Inactive previews remain regenerable. Plan/batch validation is tested above;
# stub its subprocess only so this case cannot touch operator artifacts.
scope=runpy.run_path(${JSON.stringify(path.join(__dirname, 'render.py'))},run_name='arc_render_test')
with tempfile.TemporaryDirectory() as directory:
 out=pathlib.Path(directory)
 (out/'plan.json').write_bytes(pathlib.Path(${JSON.stringify(path.join(output, 'plan.json'))}).read_bytes())
 (out/'activation.json').write_text('{"active":false}')
 scope['render'].__globals__['OUT']=out
 scope['render'].__globals__['subprocess'].run=lambda *args,**kwargs: None
 scope['render'](); scope['render']()
 assert json.loads((out/'activation.json').read_text())['active'] is False
 assert 'guarded' not in (out/'driver.toml').read_text()
`
  execFileSync('python3', ['-c', script], { stdio: 'pipe' })
  console.log('PASS: existing release state preserved; stale Safe batch rejected; active/deployed checks refuse before mutation')
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
