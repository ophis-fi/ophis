// Offline submitter preparation. Keys stay outside the checkout; stdout is public only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { root, dep, validate } = require('./plan.cjs')
const { Wallet } = dep('@ethersproject/wallet')

function keyPath(file) {
  assert(file, 'Set ARC_SOLVER_KEY_FILE to a dedicated Arc key outside the checkout')
  const resolved = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file))
  const relative = path.relative(fs.realpathSync(root), resolved)
  assert(relative.startsWith('..' + path.sep), 'Keep the solver key outside the checkout')
  assert(process.getuid() > 0, 'Run as the unprivileged signing account')
  return resolved
}

function readSolver(file) {
  const keyFile = keyPath(file)
  const fd = fs.openSync(keyFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    assert(stat.isFile() && stat.size <= 128 && (stat.mode & 0o777) === 0o600,
      'Solver key must be a regular file with mode 0600')
    assert(stat.uid === process.getuid(), 'Run as the owner of the solver key')
    const key = fs.readFileSync(fd, 'utf8').trim().replace(/^0x/, '')
    assert(/^[0-9a-fA-F]{64}$/.test(key), 'Invalid solver key file format')
    let address
    try { address = new Wallet('0x' + key).address } catch { throw new Error('Invalid solver key') }
    return { keyFile, address }
  } finally { fs.closeSync(fd) }
}

function importSolver(file, key, expected) {
  const keyFile = keyPath(file)
  const parent = fs.statSync(path.dirname(keyFile))
  assert(parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700,
    'Create the key in a signing-account-owned directory with mode 0700')
  let wallet
  try { wallet = new Wallet(key) } catch { throw new Error('Invalid solver key') }
  assert.equal(wallet.address.toLowerCase(), expected.toLowerCase(), 'Imported key differs from planned solver')
  const fd = fs.openSync(keyFile, 'wx', 0o600)
  try { fs.writeFileSync(fd, wallet.privateKey + '\n'); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
  return readSolver(keyFile)
}

function prepare(config, output, file, nonce, createSolver = false) {
  assert(!fs.existsSync(output), 'Configuration already exists; review it instead of replacing it')
  assert(Number.isSafeInteger(nonce) && nonce >= 0 && nonce <= Number.MAX_SAFE_INTEGER - 7, 'Explicit deployer nonce required')
  const keyFile = keyPath(file)
  if (createSolver) {
    // Exclusive creation: repeated commands cannot rotate or overwrite a live key.
    const wallet = Wallet.createRandom()
    importSolver(keyFile, wallet.privateKey, wallet.address)
  }
  const signer = readSolver(keyFile)
  if (config.solver) assert.equal(signer.address.toLowerCase(), config.solver.toLowerCase(), 'Configured solver differs from key')
  const prepared = validate({ ...config, solver: signer.address, nonce })
  fs.writeFileSync(output, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return prepared
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    assert(args.length === 2 || (args.length === 3 && args[2] === '--create-solver'),
      'Usage: node release/solver.cjs --nonce N [--create-solver]')
    assert(args[0] === '--nonce' && /^(0|[1-9]\d*)$/.test(args[1]), 'Explicit deployer nonce required')
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json')))
    const prepared = prepare(config, path.join(__dirname, 'config.json'), process.env.ARC_SOLVER_KEY_FILE,
      Number(args[1]), args.length === 3)
    console.log('Prepared private config.json. Arc solver public address:', prepared.solver)
    console.log('Back up the dedicated key using the existing custody procedure before funding or deployment.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { readSolver, prepare, importSolver }
