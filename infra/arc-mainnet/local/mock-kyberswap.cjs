// Loopback fixture for the existing two-request KyberSwap connector; no upstream calls.
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { createRequire } = require('node:module')
const dependency = createRequire(path.resolve(__dirname, '../../../apps/frontend/apps/cowswap-frontend/package.json'))
const { Interface } = dependency('@ethersproject/abi')
const manifest = require('./generated/deployment.json')
const tokens = ['0x3600000000000000000000000000000000000000', '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1']
const routerAddress = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
const router = new Interface(['function swap(address sell,uint256 amount,uint256 output,address receiver)'])
function validate(route) {
  assert(tokens.includes(route.tokenIn?.toLowerCase()) && tokens.includes(route.tokenOut?.toLowerCase()))
  assert.notEqual(route.tokenIn.toLowerCase(), route.tokenOut.toLowerCase())
  assert(/^\d+$/.test(route.amountIn) && BigInt(route.amountIn) > 0n)
}
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:8788')
    let data
    if (req.method === 'GET' && url.pathname === '/arc/api/v1/routes') {
      const q = Object.fromEntries(url.searchParams)
      validate(q)
      data = {routerAddress, routeSummary: {tokenIn:q.tokenIn, tokenOut:q.tokenOut,
        amountIn:q.amountIn, amountOut:q.amountIn, gas:'200000', route:[]}}
    } else {
      assert(req.method === 'POST' && url.pathname === '/arc/api/v1/route/build')
      let body = ''
      for await (const chunk of req) { body += chunk; assert(body.length < 16384) }
      const b = JSON.parse(body)
      validate(b.routeSummary)
      assert.equal(b.sender.toLowerCase(), manifest.settlement.toLowerCase())
      assert.equal(b.recipient.toLowerCase(), manifest.settlement.toLowerCase())
      assert(Number.isInteger(b.slippageTolerance) && b.slippageTolerance >= 0 && b.slippageTolerance <= 2000)
      const {tokenIn, amountIn} = b.routeSummary
      // Deterministic realized output is 1:1, so it meets any allowed slippage floor.
      data = {routerAddress, amountIn, amountOut:amountIn, gas:'200000',
        data:router.encodeFunctionData('swap', [tokenIn, amountIn, amountIn, manifest.settlement])}
    }
    res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({code:0, data}))
  } catch {
    res.writeHead(400, {'Content-Type':'application/json'}).end(JSON.stringify({code:400, message:'Unsupported local route'}))
  }
}).listen(8788, '127.0.0.1', () => console.log('Local KyberSwap fixture on 127.0.0.1:8788'))
