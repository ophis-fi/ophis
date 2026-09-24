// Operator-only macOS import. No keys in argv/logs, no RPC, no overwrite or rotation.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { dep, checkHash } = require('./plan.cjs')
const { Wallet } = dep('@ethersproject/wallet')

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--import'], 'Explicit --import required; run from your local terminal')
  assert.equal(process.platform, 'darwin', 'This imports to the existing Mac signing account only')
  const directory = path.join(os.homedir(), '.config/ophis-arc')
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'solver-staged.public.json')))
  assert.equal(metadata.keychainService, 'fi.ophis.arc.launch-staging')
  assert.match(metadata.keychainAccount, /^solver-5042-\d{8}$/)
  const file = path.join(directory, 'solver-staged.keystore.json')
  assert.equal(metadata.keystore, file)
  const stat = fs.lstatSync(file)
  assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600, 'Private owner-controlled keystore required')
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'generated/plan.json')))
  checkHash(plan)
  assert.equal(metadata.solver, plan.config.solver, 'Staged address differs from reviewed plan')
  // Authenticate before decrypting. sudo reads its password from the terminal, not a key pipe.
  execFileSync('/usr/bin/sudo', ['-v'], { stdio: 'inherit' })
  const password = execFileSync('/usr/bin/security', ['find-generic-password', '-s', metadata.keychainService,
    '-a', metadata.keychainAccount, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let wallet
  try { wallet = await Wallet.fromEncryptedJson(fs.readFileSync(file, 'utf8'), password) }
  catch { throw new Error('Unable to decrypt the staged keystore') }
  assert.equal(wallet.address, plan.config.solver)
  const destination = '/Users/ophis-driver/.config/ophis-arc/submitter.key'
  const child = `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {importSolver,readSolver}=require(${JSON.stringify(path.join(__dirname, 'solver.cjs'))});
try {const input=JSON.parse(fs.readFileSync(0,'utf8'));const file=${JSON.stringify(destination)};
fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
const result=fs.existsSync(file)?readSolver(file):importSolver(file,input.key,input.expected);
assert.equal(result.address,input.expected);process.stdout.write(JSON.stringify(result));
}catch{console.error('Isolated import rejected; no existing key was replaced');process.exitCode=1;}`
  const result = JSON.parse(execFileSync('/usr/bin/sudo', ['-n', '-u', 'ophis-driver', process.execPath, '-e', child], {
    input: JSON.stringify({ key: wallet.privateKey, expected: wallet.address }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }))
  assert.equal(result.address, plan.config.solver)
  console.log('Imported and verified Arc solver:', result.address)
  console.log('Isolated runtime key path:', result.keyFile)
  console.log('No deployment or service activation performed. Retain encrypted staging until off-site backup is confirmed.')
}
if (require.main === module) main().catch(() => { console.error('Import did not complete. Check local authentication, file permissions and the staged/planned public address; no key was printed.'); process.exitCode = 1 })
