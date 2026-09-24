// Operator-only Ledger ceremony. This file is NEVER invoked by build, render or CI.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { dep, checkHash, checkActivation, compile, build } = require('./plan.cjs')
const { checkSafe } = require('./verify.cjs')
const { JsonRpcProvider } = dep('@ethersproject/providers')
const OUT = path.join(__dirname, 'generated')

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--broadcast', '--ledger'], 'Explicit --broadcast --ledger required; unsigned plans need neither')
  const plan = JSON.parse(fs.readFileSync(path.join(OUT, 'plan.json')))
  checkHash(plan)
  checkActivation(plan, JSON.parse(fs.readFileSync(path.join(OUT, 'safe-activation.json'))))
  assert.deepEqual(build(plan.config, compile().artifacts), plan, 'Current source differs from reviewed plan')
  const url = new URL(process.env.ARC_READ_RPC_URL)
  assert.equal(url.origin, 'https://rpc.mainnet.arc.io', 'Ceremony uses the free official RPC')
  const rpc = new JsonRpcProvider(url.href, { name: 'arc', chainId: 5042 })
  assert.equal(await rpc.send('eth_chainId', []), '0x13b2')
  assert(!/anvil|hardhat|ganache/i.test(await rpc.send('web3_clientVersion', [])))
  await checkSafe(rpc, plan.config)
  const signer = execFileSync('cast', ['wallet', 'address', '--ledger'], { encoding: 'utf8' }).trim()
  assert.equal(signer.toLowerCase(), plan.config.deployer.toLowerCase(), 'Wrong Ledger account')
  const file = path.join(OUT, 'receipts.json')
  const receipts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : []
  for (const [index, tx] of plan.transactions.entries()) {
    if (receipts[index]) {
      const receipt = await rpc.getTransactionReceipt(receipts[index].transactionHash)
      const prior = await rpc.getTransaction(receipt.transactionHash)
      assert(receipt.status === 1 && receipt.contractAddress.toLowerCase() === tx.predictedAddress.toLowerCase())
      assert.equal(prior.data, tx.data); assert.equal(prior.nonce, tx.nonce)
      assert.equal(prior.from.toLowerCase(), tx.from.toLowerCase())
      continue
    }
    assert.equal(await rpc.getTransactionCount(plan.config.deployer, 'pending'), tx.nonce, 'Nonce changed; stop and prepare a new reviewed plan')
    assert(BigInt((await rpc.getGasPrice()).toString()) <= BigInt(tx.maxFeePerGas), 'Current gas price exceeds the reviewed cap; wait before broadcasting')
    assert((await rpc.getBalance(plan.config.deployer)).gte(BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas)), 'Insufficient native USDC for this gas cap')
    assert.equal(await rpc.getCode(tx.predictedAddress), '0x')
    const receipt = JSON.parse(execFileSync('cast', ['send', '--rpc-url', url.href, '--ledger', '--chain', '5042', '--json',
      '--nonce', String(tx.nonce), '--gas-limit', String(tx.gasLimit), '--gas-price', tx.maxFeePerGas,
      '--priority-gas-price', '1', '--poll-interval', '5', '--create', tx.data], { encoding: 'utf8', maxBuffer: 2 ** 20 }))
    assert.equal(Number(receipt.status), 1)
    assert.equal(receipt.contractAddress.toLowerCase(), tx.predictedAddress.toLowerCase())
    receipts.push(receipt)
    const temporary = fs.mkdtempSync(path.join(OUT, '.receipts-'))
    try {
      const pending = path.join(temporary, 'receipts.json')
      const fd = fs.openSync(pending, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(receipts, null, 2) + '\n'); fs.fsyncSync(fd) }
      finally { fs.closeSync(fd) }
      fs.renameSync(pending, file)
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  }
  console.log('Contracts deployed. Verify receipt addresses, then execute safe-activation.json through the 2-of-3 Safe and run verify.cjs.')
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
