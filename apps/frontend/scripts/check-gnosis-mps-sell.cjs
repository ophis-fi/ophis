// GNOSIS_FORK_RPC=http://127.0.0.1:8574 node scripts/check-gnosis-mps-sell.cjs
// Uses deployed contracts on a local Anvil fork; never submits live transactions.
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const { createRequire } = require('node:module')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const app = createRequire(resolve(__dirname, '../apps/cowswap-frontend/package.json'))
const { buildSync } = createRequire(app.resolve('vite/package.json'))('esbuild')
const { JsonRpcProvider, Web3Provider } = app('@ethersproject/providers')
const { Contract } = app('@ethersproject/contracts')
const folder = mkdtempSync(join(tmpdir(), 'gnosis-mps-'))
async function main(target) {
  const url = process.env.GNOSIS_FORK_RPC || 'http://127.0.0.1:8574'
  assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Local fork required')
  const provider = new JsonRpcProvider(url, 100)
  assert.match(await provider.send('web3_clientVersion', []), /anvil/i)
  const snapshot = await provider.send('evm_snapshot', [])
  try {
    for (const name of ['quote', 'router', 'input', 'execute', 'gnosis', 'outputTokens']) buildSync({
      entryPoints: [resolve(__dirname, `../apps/cowswap-frontend/src/modules/swap/services/wholeToken/${name}.service.ts`)],
      outfile: join(folder, `${name}.cjs`), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    })
    const { getDirectQuotes } = require(join(folder, 'quote.cjs'))
    const { executeDirectSwap } = require(join(folder, 'execute.cjs'))
    const { buildDirectTransaction } = require(join(folder, 'router.cjs'))
    const { getInputApprovals, simulationState } = require(join(folder, 'input.cjs'))
    const { GNOSIS_MPS, WXDAI, GNOSIS_ROUTER, GNOSIS_EXECUTOR, GNOSIS_PAYMENTS, SUSHI_V2_ROUTER } = require(join(folder, 'gnosis.cjs'))
    const [account, , partner] = await provider.listAccounts()
    // Public Anvil fixture addresses can have live EIP-7702 delegations that reject native transfers.
    const recipient = '0x' + randomBytes(20).toString('hex')
    assert.equal(await provider.getCode(recipient), '0x')
    const feeRecipient = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'
    const abi = ['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']
    const outputToken = target || WXDAI
    const unwrap = outputToken === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
    const mps = new Contract(GNOSIS_MPS, abi, provider), output = new Contract(unwrap ? WXDAI : outputToken, abi, provider)
    const signer = provider.getSigner(account)
    const wallet = new Web3Provider({ request: ({ method, params }) => provider.send(method, params || []) })
    const request = { chainId: 100, inputToken: GNOSIS_MPS, outputToken, account, recipient, budget: 1n, slippageBps: 50,
      fees: [{ recipient: feeRecipient, bps: 1 }, { recipient: partner, bps: 12.5 }] }
    const state = simulationState(account, GNOSIS_MPS)
    for (const [method, args] of [['balanceOf', [account]], ['allowance', [account, GNOSIS_ROUTER]]]) {
      const raw = await provider.send('eth_call', [{ to: GNOSIS_MPS, data: mps.interface.encodeFunctionData(method, args) }, 'latest', state])
      assert.equal(BigInt(raw), 10n ** 18n)
    }
    const [quote] = await getDirectQuotes(provider, request)
    assert(quote && quote.buyAmount > 0n, 'One MPS must quote on Gnosis')
    assert(quote.needsApproval)
    await assert.rejects(executeDirectSwap(wallet, provider, quote, () => true), /Insufficient input balance/)
    for (const [address, override] of Object.entries(state)) {
      if (override.stateDiff) await provider.send('anvil_setStorageAt', [address, Object.keys(override.stateDiff)[0], '0x' + '1'.padStart(64, '0')])
    }
    for (const tx of await getInputApprovals(provider, account, 1n, quote.expiresAt, GNOSIS_MPS, 100))
      assert.equal((await (await signer.sendTransaction(tx)).wait()).status, 1)
    assert.equal((await mps.allowance(account, GNOSIS_ROUTER)).toString(), '1')
    const [ready] = await getDirectQuotes(provider, request)
    assert(!ready.needsApproval)
    assert.equal(ready.minBuyAmount, ready.buyAmount * 9950n / 10000n)
    assert.throws(() => buildDirectTransaction({ ...ready, chainId: 1 }))
    assert.throws(() => buildDirectTransaction({ ...ready, recipient: GNOSIS_EXECUTOR }))
    assert.throws(() => buildDirectTransaction({ ...ready, minBuyAmount: 0n }))
    assert.throws(() => buildDirectTransaction({ ...ready, outputToken: GNOSIS_MPS }))
    await assert.rejects(provider.estimateGas(buildDirectTransaction({ ...ready, expiresAt: 1 })))
    await assert.rejects(provider.estimateGas(buildDirectTransaction({ ...ready, buyAmount: ready.buyAmount * 2n, minBuyAmount: ready.buyAmount * 2n })))
    await assert.rejects(executeDirectSwap(wallet, provider, ready, () => false), /changed or expired/)
    const targets = [recipient, feeRecipient, partner, GNOSIS_EXECUTOR, GNOSIS_PAYMENTS, GNOSIS_ROUTER]
    const before = await Promise.all(targets.map(a => output.balanceOf(a)))
    const nativeBefore = await Promise.all(targets.map(a => provider.getBalance(a)))
    ready.quotedAt = Date.now()
    const receipt = await (await executeDirectSwap(wallet, provider, ready, () => true)).wait()
    assert.equal(receipt.status, 1)
    assert.equal((await mps.balanceOf(account)).toString(), '0', 'Exactly one MPS spent')
    assert.equal((await mps.allowance(GNOSIS_EXECUTOR, SUSHI_V2_ROUTER)).toString(), '0', 'No executor approval remains')
    for (let i = 0; i < targets.length; i++) {
      const delta = BigInt((await output.balanceOf(targets[i])).sub(before[i]).toString())
      assert.equal(delta, i === 0 ? (unwrap ? 0n : ready.buyAmount) : i < 3 ? ready.fees[i - 1].amount : 0n)
      const nativeDelta = BigInt((await provider.getBalance(targets[i])).sub(nativeBefore[i]).toString())
      assert.equal(nativeDelta, unwrap && i === 0 ? ready.buyAmount : 0n)
    }
    assert.equal((await mps.balanceOf(GNOSIS_EXECUTOR)).toString(), '0')
    console.log(JSON.stringify({ soldMps: '1', outputToken, received: ready.buyAmount.toString(), gasUsed: receipt.gasUsed.toString() }))
    console.log('PASS: exact input, bounded approvals, output fees, recipient, deadline, slippage, freshness, no residual funds')
  } finally { await provider.send('evm_revert', [snapshot]) }
}
;(async () => {
  await main()
  const { GNOSIS_USDC, GNOSIS_USDT, GNOSIS_WETH } = require(join(folder, 'outputTokens.cjs'))
  for (const output of ['0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', GNOSIS_USDC, GNOSIS_USDT, GNOSIS_WETH]) await main(output)
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => rmSync(folder, { recursive: true, force: true }))
