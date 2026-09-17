// MPS_FORK_RPC=http://127.0.0.1:8573 node scripts/check-mps-sell.cjs
// Uses deployed Ethereum contracts on an isolated Anvil fork; never submits live transactions.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const app = createRequire(resolve(__dirname, '../apps/cowswap-frontend/package.json'))
const { buildSync } = createRequire(app.resolve('vite/package.json'))('esbuild')
const { JsonRpcProvider, Web3Provider } = app('@ethersproject/providers')
const { Contract } = app('@ethersproject/contracts')
const { defaultAbiCoder } = app('@ethersproject/abi')
const { keccak256 } = app('@ethersproject/keccak256')
const folder = mkdtempSync(join(tmpdir(), 'mps-sell-'))
async function main() {
  const url = process.env.MPS_FORK_RPC || 'http://127.0.0.1:8573'
  assert(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Local fork required')
  const provider = new JsonRpcProvider(url, 1)
  assert.match(await provider.send('web3_clientVersion', []), /anvil/i)
  const snapshot = await provider.send('evm_snapshot', [])
  try {
    for (const name of ['quote', 'router', 'input', 'execute']) buildSync({
      entryPoints: [resolve(__dirname, `../apps/cowswap-frontend/src/modules/swap/services/wholeToken/${name}.service.ts`)],
      outfile: join(folder, `${name}.cjs`), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    })
    const { getDirectQuotes } = require(join(folder, 'quote.cjs'))
    const { executeDirectSwap } = require(join(folder, 'execute.cjs'))
    const { buildDirectTransaction, MPS, WETH, USDC, ROUTER } = require(join(folder, 'router.cjs'))
    const { getInputApprovals, simulationState, PERMIT2 } = require(join(folder, 'input.cjs'))
    const [account, recipient, feeRecipient] = await provider.listAccounts()
    for (const address of [account, recipient, feeRecipient]) await provider.send('anvil_setCode', [address, '0x'])
    await provider.send('anvil_setNextBlockBaseFeePerGas', ['0x5f5e100'])
    await provider.send('evm_mine', [])
    const signer = provider.getSigner(account)
    const wallet = new Web3Provider({ request: ({ method, params }) => provider.send(method, params || []) })
    const abi = ['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']
    const mps = new Contract(MPS, abi, provider), weth = new Contract(WETH, abi, provider), usdc = new Contract(USDC, abi, provider)
    // Verify simulation slots against deployed getters before using them to quote.
    const state = simulationState(account, MPS)
    for (const [method, args] of [['balanceOf', [account]], ['allowance', [account, PERMIT2]]]) {
      const raw = await provider.send('eth_call', [{ to: MPS, data: mps.interface.encodeFunctionData(method, args) }, 'latest', state])
      assert.equal(BigInt(raw), 10n ** 18n)
    }
    const request = { inputToken: MPS, account, recipient, budget: 1n, slippageBps: 50, fees: [{ recipient: feeRecipient, bps: 51.005 }] }
    const quotes = await getDirectQuotes(provider, request)
    assert(quotes.length > 0, 'One MPS must have an executable ETH quote')
    assert(quotes.some(q => q.route.viaV2), 'Mixed v2/v3 route is compared')
    // V3 exact-input rounds its input after fees to zero for a single indivisible MPS.
    assert(quotes.every(q => q.route.viaV2), 'One MPS must use the viable v2 first hop')
    assert(quotes.every(q => q.needsApproval))
    await assert.rejects(provider.estimateGas(buildDirectTransaction(quotes[0])), 'Actual unfunded wallet must fail')
    // Only the fork fixture gets one MPS. The swap then uses real token/Permit2 approvals.
    const balanceSlot = keccak256(defaultAbiCoder.encode(['address', 'uint256'], [account, 0]))
    await provider.send('anvil_setStorageAt', [MPS, balanceSlot, '0x' + '1'.padStart(64, '0')])
    const approvals = await getInputApprovals(provider, account, 1n, quotes[0].expiresAt + 1800, MPS)
    assert.equal(approvals.length, 2)
    for (const tx of approvals) assert.equal((await (await signer.sendTransaction(tx)).wait()).status, 1)
    assert.equal((await mps.allowance(account, PERMIT2)).toString(), '1', 'Exact token approval')
    assert.equal((await getInputApprovals(provider, account, 1n, quotes[0].expiresAt, MPS)).length, 0)
    const ready = await getDirectQuotes(provider, request)
    for (const quote of ready) {
      const inner = await provider.send('evm_snapshot', [])
      try {
        assert.equal(quote.sellAmount, 1n)
        assert.equal(quote.maxTotal, 1n)
        assert.equal(quote.minBuyAmount, quote.buyAmount * 9950n / 10000n)
        const before = await Promise.all([provider.getBalance(recipient), weth.balanceOf(feeRecipient), weth.balanceOf(ROUTER), usdc.balanceOf(ROUTER), mps.balanceOf(ROUTER)])
        assert.throws(() => buildDirectTransaction({ ...quote, minBuyAmount: 0n }))
        assert.throws(() => buildDirectTransaction({ ...quote, budget: 2n }))
        assert.throws(() => buildDirectTransaction({ ...quote, fees: [{ recipient: feeRecipient, amount: -1n }] }))
        await assert.rejects(provider.estimateGas(buildDirectTransaction({ ...quote, expiresAt: 1 })))
        await assert.rejects(provider.estimateGas(buildDirectTransaction({ ...quote, buyAmount: quote.buyAmount * 2n, minBuyAmount: quote.buyAmount * 2n })))
        const receipt = await (await executeDirectSwap(wallet, provider, quote, () => true)).wait()
        assert.equal(receipt.status, 1)
        assert.equal((await mps.balanceOf(account)).toString(), '0', 'Exactly one MPS spent')
        const received = BigInt((await provider.getBalance(recipient)).sub(before[0]).toString())
        assert.equal(received, quote.buyAmount, 'Quoted net ETH received by chosen recipient')
        assert(received >= quote.minBuyAmount)
        assert.equal(BigInt((await weth.balanceOf(feeRecipient)).sub(before[1]).toString()), quote.fees[0].amount)
        assert((await weth.balanceOf(ROUTER)).eq(before[2]))
        assert((await usdc.balanceOf(ROUTER)).eq(before[3]))
        assert((await mps.balanceOf(ROUTER)).eq(before[4]))
        assert(receipt.gasUsed.lte(quote.gasLimit.toString()))
        console.log(JSON.stringify({ route: quote.route.label, soldMps: '1', receivedWei: received.toString(), gasUsed: receipt.gasUsed.toString() }))
      } finally { await provider.send('evm_revert', [inner]) }
    }
    // Exhaust a concentrated-liquidity v3 route: unused input must return to its sender.
    const partialBudget = 10n ** 18n
    await provider.send('anvil_setStorageAt', [MPS, balanceSlot, '0x' + partialBudget.toString(16).padStart(64, '0')])
    const limited = await getDirectQuotes(provider, { ...request, budget: partialBudget })
    assert(!limited.some(q => !q.route.viaV2 && q.route.tokens.length === 2), 'Do not advertise exhausted liquidity as a full-input sale')
    // A stale quote can still encounter depleted liquidity at execution; refunds remain mandatory.
    const partial = { ...ready[0], route: { label: 'Partial-fill fixture', tokens: [MPS, WETH], fees: [10000] },
      budget: partialBudget, sellAmount: partialBudget, maxInput: partialBudget, maxTotal: partialBudget,
      buyAmount: 1n, minBuyAmount: 1n, fees: [], gasLimit: 30000000n }
    const usdcBefore = await usdc.balanceOf(account)
    const usdcSlot = keccak256(defaultAbiCoder.encode(['address', 'uint256'], [ROUTER, 9]))
    await provider.send('anvil_setStorageAt', [USDC, usdcSlot, '0x' + 'b'.padStart(64, '0')])
    assert.equal((await usdc.balanceOf(ROUTER)).toString(), '11', 'USDC residual fixture must be nonzero')
    for (const tx of await getInputApprovals(provider, account, partialBudget, partial.expiresAt, MPS))
      await (await signer.sendTransaction(tx)).wait()
    partial.quotedAt = Date.now()
    assert.equal((await (await executeDirectSwap(wallet, provider, partial, () => true)).wait()).status, 1)
    const refunded = BigInt((await mps.balanceOf(account)).toString())
    assert(refunded > 0n && refunded < partialBudget, 'Partial fill refunds unused MPS to sender')
    assert.equal((await mps.balanceOf(ROUTER)).toString(), '0', 'No MPS remains publicly sweepable')
    assert.equal((await usdc.balanceOf(ROUTER)).toString(), '0', 'No intermediate USDC remains publicly sweepable')
    assert.equal((await usdc.balanceOf(account)).sub(usdcBefore).toString(), '11', 'USDC residual returns to sender')
    console.log('PASS: exact MPS input, bounded approvals, net ETH output, fees, recipient, slippage, deadline, partial-fill refunds')
  } finally { await provider.send('evm_revert', [snapshot]) }
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => rmSync(folder, { recursive: true, force: true }))
