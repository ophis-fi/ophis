// A local stand-in for the public orderbooks of the desk, on http://127.0.0.1:8795/<chainId>. Locally ORDERBOOK_URL points
// here (in .dev.vars, made by "pnpm seed"): the Worker holds no stub and no switch, and nothing reaches a real orderbook.
// Its answers are the real ones of tests/fixtures/orderbook.json (copied from api.cow.fi, read-only), with the fields of
// the order asked about put in. It shares no code with the Worker: the order id is hashed here with viem.
//   node scripts/orderbook-stub.mjs     serve until stopped ("pnpm dev" and "pnpm test:e2e" start it themselves)
// The state of a sent order: GET /stub/<state> (open, fulfilled, expired, cancelled), then every sent order reads so.
// It also stands in for the two JSON-RPC endpoints of each chain that Overview reads balances on (RPC_URL in .dev.vars,
// http://127.0.0.1:8795/rpc/<chainId>/<a|b>): eth_chainId, and the one Multicall3 aggregate3 of balanceOf calls (and of
// Multicall3's own getEthBalance, for ETH), with the fixed balances of TEST_BALANCES below, the same for every wallet.
// Nothing reaches a real chain. ETH is priced as WETH, which the settlement pays it out of.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { concat, decodeFunctionData, encodeFunctionResult, hashTypedData, numberToHex, parseAbi } from 'viem'

export const PORT = 8795
const REAL = JSON.parse(readFileSync(new URL('../tests/fixtures/orderbook.json', import.meta.url), 'utf8'))
const SETTLEMENT = { 1: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', 10: '0x310784c7FCE12d578dA6f53460777bAc9718B859', 8453: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41', 42161: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' }
const FIELDS = [['sellToken', 'address'], ['buyToken', 'address'], ['receiver', 'address'], ['sellAmount', 'uint256'], ['buyAmount', 'uint256'], ['validTo', 'uint32'], ['appData', 'bytes32'], ['feeAmount', 'uint256'], ['kind', 'string'], ['partiallyFillable', 'bool'], ['sellTokenBalance', 'string'], ['buyTokenBalance', 'string']]
const STATES = ['open', 'fulfilled', 'expired', 'cancelled']
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const WETHS = ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0x4200000000000000000000000000000000000006', '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', ETH]
const MULTICALL = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) view returns (Result[] returnData)', 'function balanceOf(address owner) view returns (uint256)', 'function getEthBalance(address addr) view returns (uint256)'])
// Test balances, in atoms: 3.25 ETH, 12.5 WETH, 250,000 USDC (all on every chain); OP Mainnet USDC 0 (a wallet holds none of it).
export const TEST_BALANCES = { eth: 3_250_000_000_000_000_000n, weth: 12_500_000_000_000_000_000n, usdc: 250_000_000_000n, opUsdc: 0n }
const balanceOf = (token) => (token === ETH ? TEST_BALANCES.eth : WETHS.includes(token) ? TEST_BALANCES.weth : token === '0x0b2c639c533813f4aa9d7837caf62653d097ff85' ? TEST_BALANCES.opUsdc : TEST_BALANCES.usdc)

/** Starts the stand-in on 127.0.0.1 and returns the function that stops it. */
export function start() {
  let state = 'open'
  const sent = new Map() // uid: the order as posted
  const server = createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const picked = request.method === 'GET' && /^\/stub\/([a-z]+)$/.exec(request.url)?.[1]
    if (picked && STATES.includes(picked)) return send(200, { state: (state = picked) })
    const rpc = /^\/rpc\/(\d+)\/[ab]$/.exec(request.url)?.[1]
    const [, chainId, path] = /^\/(\d+)(\/.*)$/.exec(request.url) ?? []
    if (!SETTLEMENT[chainId] && !SETTLEMENT[rpc]) return send(404, { errorType: 'NotFound' })
    let text = ''
    request.on('data', (chunk) => (text.length < 100_000 ? (text += chunk) : request.destroy()))
    request.on('end', () => {
      const body = text ? JSON.parse(text) : {}
      if (rpc) {
        const answer = (result) => send(200, { jsonrpc: '2.0', id: body.id, result })
        if (body.method === 'eth_chainId') return answer(numberToHex(Number(rpc)))
        const call = body.method === 'eth_call' && body.params[0].to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11' && decodeFunctionData({ abi: MULTICALL, data: body.params[0].data })
        if (call?.functionName !== 'aggregate3') return send(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'not in the stand-in' } })
        return answer(encodeFunctionResult({ abi: MULTICALL, functionName: 'aggregate3', result: call.args[0].map((c) => ({ success: true, returnData: encodeFunctionResult({ abi: MULTICALL, functionName: 'balanceOf', result: balanceOf(decodeFunctionData({ abi: MULTICALL, data: c.callData }).functionName === 'getEthBalance' ? ETH : c.target.toLowerCase()) }) })) }))
      }
      if (request.method === 'POST' && path === '/api/v1/quote') {
        // The Ophis orderbook of OP Mainnet, as it answered read-only quotes on 2026-11-14: a key wallet's quote valid more than 3 hours is refused.
        if (chainId === '10' && body.signingScheme === 'eip712' && body.validFor > 10_800) return send(400, { errorType: 'ExcessiveValidTo', description: 'validTo is too far into the future', code: 4012 })
        // The real quote, for the asked tokens and amount: its fee and buy amount in the real proportion to what it sells.
        const real = REAL.quote.response.quote
        const whole = BigInt(body.sellAmountBeforeFee)
        const fee = (whole * BigInt(real.feeAmount)) / (BigInt(real.sellAmount) + BigInt(real.feeAmount))
        // The real price of WETH in EURC: for a sale of WETH as it is, for a purchase of WETH the other way round.
        const [up, down] = WETHS.includes(body.buyToken.toLowerCase()) ? [real.sellAmount, real.buyAmount] : [real.buyAmount, real.sellAmount]
        const buyAmount = ((whole - fee) * BigInt(up)) / BigInt(down)
        return send(200, { ...REAL.quote.response, from: body.from.toLowerCase(), quote: { ...real, sellToken: body.sellToken.toLowerCase(), buyToken: body.buyToken.toLowerCase(), receiver: body.receiver?.toLowerCase() ?? null, sellAmount: String(whole - fee), feeAmount: String(fee), buyAmount: String(buyAmount), appData: body.appData, appDataHash: body.appDataHash, signingScheme: body.signingScheme } })
      }
      if (request.method === 'POST' && path === '/api/v1/orders') {
        const message = { ...body, appData: body.appDataHash, sellAmount: BigInt(body.sellAmount), buyAmount: BigInt(body.buyAmount), feeAmount: BigInt(body.feeAmount) }
        const digest = hashTypedData({ domain: { name: 'Gnosis Protocol', version: 'v2', chainId: Number(chainId), verifyingContract: SETTLEMENT[chainId] }, types: { Order: FIELDS.map(([name, type]) => ({ name, type })) }, primaryType: 'Order', message })
        const uid = concat([digest, body.from, numberToHex(body.validTo, { size: 4 })]).toLowerCase()
        if (sent.has(uid)) return send(400, { errorType: 'DuplicatedOrder', description: 'order already exists' })
        sent.set(uid, body)
        return send(201, uid)
      }
      // The full appData of an ETH sale, whose transaction commits only its hash: stored, its hash answered.
      const appHash = request.method === 'PUT' && /^\/api\/v1\/app_data\/(0x[0-9a-f]{64})$/.exec(path)?.[1]
      if (appHash) return send(201, appHash)
      if (request.method === 'DELETE' && path === '/api/v1/orders') {
        for (const uid of body.orderUids ?? []) if (sent.has(uid)) sent.get(uid).cancelled = true
        return send(200, 'Cancelled')
      }
      const uid = /^\/api\/v1\/orders\/(0x[0-9a-f]{112})$/.exec(path)?.[1] ?? /^\/api\/v1\/trades\?orderUid=(0x[0-9a-f]{112})$/.exec(path)?.[1]
      const order = sent.get(uid)
      if (request.method !== 'GET' || !order) return send(404, { errorType: 'NotFound', description: 'Order was not found' })
      const status = order.cancelled ? 'cancelled' : order.signingScheme === 'presign' && state === 'open' ? 'presignaturePending' : state
      const filled = status === 'fulfilled'
      const fields = { uid, owner: order.from.toLowerCase(), receiver: order.receiver.toLowerCase(), sellToken: order.sellToken.toLowerCase(), buyToken: order.buyToken.toLowerCase(), sellAmount: order.sellAmount, buyAmount: order.buyAmount, validTo: order.validTo, signingScheme: order.signingScheme }
      if (path.startsWith('/api/v1/trades')) return send(200, filled ? REAL.trades.response.map((t) => ({ ...t, orderUid: uid, owner: fields.owner, sellToken: fields.sellToken, buyToken: fields.buyToken, sellAmount: order.sellAmount, buyAmount: order.buyAmount })) : [])
      // The fee of the real order, in the same proportion to what was sold, in the asset sold.
      const fee = filled ? String((BigInt(order.sellAmount) * BigInt(REAL.order.response.executedFee)) / BigInt(REAL.order.response.executedSellAmount)) : '0'
      return send(200, { ...REAL.order.response, ...fields, status, executedSellAmount: filled ? order.sellAmount : '0', executedBuyAmount: filled ? order.buyAmount : '0', executedFee: fee, executedFeeToken: fields.sellToken, fullAppData: order.appData })
    })
  })
  server.listen(PORT, '127.0.0.1')
  return () => new Promise((resolve) => server.close(resolve))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start()
  console.log(`orderbook stand-in on http://127.0.0.1:${PORT}/<chainId>`)
}
