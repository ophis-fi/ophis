// Run on an Anvil mainnet fork pinned to block 25990611 with base fee 0.1 gwei.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const app = createRequire(resolve(__dirname, '../apps/cowswap-frontend/package.json'))
const { buildSync } = createRequire(app.resolve('vite/package.json'))('esbuild')
const { JsonRpcProvider } = app('@ethersproject/providers')
const { Contract } = app('@ethersproject/contracts')
const folder = mkdtempSync(join(tmpdir(), 'mps-execution-'))
async function main() {
  const provider = new JsonRpcProvider(process.env.MPS_FORK_RPC || 'http://127.0.0.1:8557', 1)
  assert.match(await provider.send('web3_clientVersion', []), /anvil/i, 'Never send test transactions to a real network')
  for (const name of ['quote', 'router', 'input']) buildSync({
    entryPoints: [resolve(__dirname, `../apps/cowswap-frontend/src/modules/swap/services/wholeToken/${name}.service.ts`)],
    outfile: join(folder, `${name}.cjs`), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  })
  const { getDirectQuotes } = require(join(folder, 'quote.cjs'))
  const { buildDirectTransaction, MPS, WETH, USDC, ROUTER } = require(join(folder, 'router.cjs'))
  const [account, recipient, feeRecipient] = await provider.listAccounts()
  // Public Anvil accounts may have EIP-7702 delegation on mainnet; isolate the fixture.
  for (const address of [account, recipient, feeRecipient]) await provider.send('anvil_setCode', [address, '0x'])
  const signer = provider.getSigner(account)
  const abi = ['function balanceOf(address) view returns(uint256)']
  const mps = new Contract(MPS, abi, provider), weth = new Contract(WETH, abi, provider), usdc = new Contract(USDC, abi, provider)
  const request = { account, recipient, budget: 3300000000000000n, deadlineSeconds: 600, slippageBps: 50, fees: [{ recipient: feeRecipient, bps: 51.005 }] }
  const quotes = await getDirectQuotes(provider, request)
  assert.equal(quotes.length, 9, 'All nine expected fee-tier routes must remain executable')
  await assert.rejects(getDirectQuotes(provider, { ...request, deadlineSeconds: 0 }), /Invalid deadline/)
  const block = await provider.getBlock('latest'); assert(quotes.every(q => q.expiresAt === block.timestamp + request.deadlineSeconds))
  for (const q of quotes) {
    const snapshot = await provider.send('evm_snapshot', [])
    const before = await Promise.all([provider.getBalance(account), mps.balanceOf(recipient), weth.balanceOf(feeRecipient), weth.balanceOf(ROUTER), provider.getBalance(ROUTER), usdc.balanceOf(ROUTER)])
    assert(q.maxTotal <= request.budget)
    assert.equal(q.buyAmount, 1n)
    const tx = await signer.sendTransaction(buildDirectTransaction(q))
    const receipt = await tx.wait()
    assert.equal(receipt.status, 1)
    const spent = BigInt(before[0].sub(await provider.getBalance(account)).toString())
    const gas = BigInt(receipt.gasUsed.mul(receipt.effectiveGasPrice).toString())
    assert.equal(BigInt((await mps.balanceOf(recipient)).sub(before[1]).toString()), q.buyAmount)
    const fee = q.fees.reduce((sum, f) => sum + f.amount, 0n)
    assert.equal(spent - gas, q.sellAmount + fee, 'Unused slippage allowance must return to sender')
    assert.equal(BigInt((await weth.balanceOf(feeRecipient)).sub(before[2]).toString()), fee)
    assert((await weth.balanceOf(ROUTER)).eq(before[3]))
    assert((await provider.getBalance(ROUTER)).eq(before[4]))
    assert((await usdc.balanceOf(ROUTER)).eq(before[5]))
    await provider.send('evm_revert', [snapshot])
    console.log(JSON.stringify({ route: q.route.label, mps: '1', inputWei: q.sellAmount.toString(), gasUsed: receipt.gasUsed.toString(), refundChecked: true }))
  }
  const mixed = quotes.find(q => q.route.viaV2)
  const snapshot = await provider.send('evm_snapshot', [])
  await (await signer.sendTransaction(buildDirectTransaction(mixed))).wait()
  assert.equal((await (await signer.sendTransaction(buildDirectTransaction(mixed))).wait()).status, 1, 'Mixed route tolerates reserve movement')
  await provider.send('evm_revert', [snapshot])
  await checkUsdc(provider, signer, { account, recipient, feeRecipient }, { getDirectQuotes, buildDirectTransaction, USDC, MPS, ROUTER }, folder)
  const q = quotes[0]
  await assert.rejects(provider.estimateGas(buildDirectTransaction({ ...q, maxInput: q.sellAmount - 1n, sellAmount: q.sellAmount - 1n })))
  await assert.rejects(provider.estimateGas(buildDirectTransaction({ ...q, expiresAt: 1 })))
  assert.throws(() => buildDirectTransaction({ ...q, budget: 1n }))
  for (const recipient of [ROUTER, ...[0, 1, 2].map(n => '0x' + n.toString(16).padStart(40, '0'))]) for (const invalid of [{ account: recipient }, { recipient }, { fees: [{ recipient, amount: 1n }] }]) assert.throws(() => buildDirectTransaction({ ...q, ...invalid }))
  await assert.rejects(getDirectQuotes(provider, { ...request, slippageBps: -1 }))
  console.log('PASS: exact output, all-in budget, fee recipient, ETH refunds, empty router balances, price limit and deadline')
}
async function checkUsdc(provider, signer, { account, recipient, feeRecipient }, { getDirectQuotes, buildDirectTransaction, USDC, MPS, ROUTER }, folder) {
  const snapshot = await provider.send('evm_snapshot', [])
  try {
    const { getInputApprovals } = require(join(folder, 'input.cjs'))
    const whale = '0x55FE002aefF02F77364de339a1292923A15844B8'
    await provider.send('anvil_impersonateAccount', [whale])
    await provider.send('anvil_setBalance', [whale, '0x3635c9adc5dea00000'])
    const abi = ['function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)']
    const usdc = new Contract(USDC, abi, signer), mps = new Contract(MPS, abi, provider)
    await (await usdc.connect(provider.getSigner(whale)).transfer(account, 10000000)).wait()
    const secondFee = '0x4444444444444444444444444444444444444444'
    await provider.send('anvil_setCode', [secondFee, '0x'])
    const request = { inputToken: USDC, account, recipient, budget: 10000000n, deadlineSeconds: 600, slippageBps: 50, fees: [{ recipient: feeRecipient, bps: 50 }, { recipient: secondFee, bps: 1 }] }
    const quotes = await getDirectQuotes(provider, request)
    assert.equal(quotes.length, 6, 'Compare direct USDC v2/v3 and every viable WETH intermediate tier')
    assert(quotes[0].needsApproval)
    const approvals = await getInputApprovals(provider, account, request.budget, quotes[0].expiresAt + 1800)
    assert.equal(approvals.length, 2)
    for (const tx of approvals) assert.equal((await (await signer.sendTransaction(tx)).wait()).status, 1)
    const ready = await getDirectQuotes(provider, request)
    assert(ready.every(q => !q.needsApproval))
    for (const q of ready) {
      const inner = await provider.send('evm_snapshot', [])
      const before = await Promise.all([usdc.balanceOf(account), mps.balanceOf(recipient), usdc.balanceOf(feeRecipient), usdc.balanceOf(secondFee), usdc.balanceOf(ROUTER)])
      assert.equal(q.buyAmount, 1n)
      const receipt = await (await signer.sendTransaction(buildDirectTransaction(q))).wait()
      assert.equal(receipt.status, 1)
      assert.equal(BigInt((await mps.balanceOf(recipient)).sub(before[1]).toString()), 1n)
      const fee = q.fees.reduce((sum, f) => sum + f.amount, 0n)
      assert.equal(BigInt(before[0].sub(await usdc.balanceOf(account)).toString()), q.sellAmount + fee)
      assert.equal(BigInt((await usdc.balanceOf(feeRecipient)).sub(before[2]).toString()), q.fees[0].amount)
      assert.equal(BigInt((await usdc.balanceOf(secondFee)).sub(before[3]).toString()), q.fees[1].amount)
      assert((await usdc.balanceOf(ROUTER)).eq(before[4]))
      assert(receipt.gasUsed.lte(q.gasLimit.toString()))
      await provider.send('evm_revert', [inner])
      console.log(JSON.stringify({ input: 'USDC', route: q.route.label, amount: q.sellAmount.toString(), output: '1', bothFeesPaid: true, refundChecked: true }))
    }
  } finally { await provider.send('evm_revert', [snapshot]) }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => rmSync(folder, { recursive: true, force: true }))
