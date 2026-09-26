// Read-only mainnet settlement probes. No keys, signing or broadcast methods.
// node infra/arc-mainnet/verify_direct.cjs --live
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { dep, root } = require('./release/plan.cjs')
const { Interface, defaultAbiCoder: abi } = dep('@ethersproject/abi')
const { _TypedDataEncoder } = dep('@ethersproject/hash')
const { hexConcat, hexZeroPad } = dep('@ethersproject/bytes')
const usdc = '0x3600000000000000000000000000000000000000'
const eurc = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1'
const settlement = '0x78799f98276efba1edeed32eae03a3fd8cdfec3a'
const solver = '0x839029e110f4954e05afad4fa222cfe93ce6d86f'
const aero = '0x7275fa44c67bba8d921422e600b4ed396209c886'
const pool = '0xbe080ac37ad1305dfcc9521f5e6f68cfdc41b7fa'
const ur = '0x8702463e73f74d0b6765abceb314ef07acb92650'
const archery = '0x3b37e67c973683f7fe8a0f304dedfaf475fec138'
const maximum = (2n ** 256n - 1n).toString()
const input = 1_000_000_000n
const keyType = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'
const zero = '0x0000000000000000000000000000000000000000'
const execute = new Interface(['function execute(bytes,bytes[],uint256)'])
const token = new Interface(['function approve(address,uint256)', 'function transfer(address,uint256)'])
const tradeType = 'tuple(uint256 sellTokenIndex,uint256 buyTokenIndex,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,uint256 flags,uint256 executedAmount,bytes signature)'
const interaction = 'tuple(address target,uint256 value,bytes callData)'
const settle = new Interface([`function settle(address[],uint256[],${tradeType}[],${interaction}[][3])`])
const orderTypes = { Order: [['sellToken','address'],['buyToken','address'],['receiver','address'],['sellAmount','uint256'],['buyAmount','uint256'],['validTo','uint32'],['appData','bytes32'],['feeAmount','uint256'],['kind','string'],['partiallyFillable','bool'],['sellTokenBalance','string'],['buyTokenBalance','string']].map(([name,type]) => ({name,type})) }
let requests = 0
let rpcUrl = 'https://rpc.mainnet.arc.io'
async function rpc(method, params) {
  assert(['eth_chainId','eth_getBlockByNumber','eth_call','eth_getCode'].includes(method))
  assert(++requests <= 24, 'Read budget exhausted')
  // Public endpoint is rate-limited; never retry or use a paid fallback.
  await new Promise(resolve => setTimeout(resolve, 500))
  const response = await fetch(rpcUrl, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:requests,method,params}), signal:AbortSignal.timeout(20_000) })
  assert(response.ok, `RPC HTTP ${response.status}`)
  const result = await response.json()
  if (result.error) throw Object.assign(new Error(JSON.stringify(result.error)), result.error)
  return result.result
}
async function main(options = {}) {
  rpcUrl = options.rpcUrl || rpcUrl
  assert.equal(await rpc('eth_chainId', []), '0x13b2')
  const block = await rpc('eth_getBlockByNumber', ['latest', false])
  const ref = {blockHash:block.hash, requireCanonical:true}
  const call = (to, data) => rpc('eth_call', [{to,data}, ref])
  const compiled = JSON.parse(execFileSync(path.join(process.env.HOME, '.solc-select/artifacts/solc-0.8.30/solc-0.8.30'), ['--optimize','--evm-version','shanghai','--combined-json','bin-runtime','infra/arc-mainnet/local/ReadOnlyV3Probe.sol'], {cwd:root, encoding:'utf8'}))
  const runtime = Object.entries(compiled.contracts).find(([name]) => name.endsWith(':ReadOnlySettlementProbe'))[1]['bin-runtime']
  async function probe(name, router, minimum, calls) {
    assert.notEqual(await rpc('eth_getCode', [router, ref]), '0x')
    if (options.driverUrl) {
      const params = new URLSearchParams({sellToken:usdc,buyToken:eurc,amount:input.toString(),kind:'sell',deadline:new Date(Date.now()+30_000).toISOString()})
      const response = await fetch(`${options.driverUrl}/${name}/quote?${params}`, {signal:AbortSignal.timeout(35_000)})
      const quote = await response.json()
      assert(response.ok, JSON.stringify(quote))
      assert.equal(quote.solver.toLowerCase(), solver)
      assert.deepEqual(quote.preInteractions, [])
      assert.equal(input*BigInt(quote.clearingPrices[usdc])/BigInt(quote.clearingPrices[eurc]), minimum)
      // Compare the real Rust solver/driver route against the independent ABI
      // encoding, then execute precisely the driver's returned interactions.
      const routed = quote.interactions.filter(i => i.target.toLowerCase() === router)
      assert.equal(routed.length, 1)
      assert.equal(routed[0].callData.toLowerCase(), calls.at(-1)[2].toLowerCase())
      calls = quote.interactions.map(i => [i.target,i.value,i.callData])
      assert.equal(calls.length, name === 'uniswap-v4' ? 2 : 3)
    }
    const order = {sellToken:usdc,buyToken:eurc,receiver:solver,sellAmount:input.toString(),buyAmount:minimum.toString(),validTo:Number(BigInt(block.timestamp))+3600,appData:hexZeroPad('0x',32),feeAmount:'0',kind:'sell',partiallyFillable:false,sellTokenBalance:'erc20',buyTokenBalance:'erc20'}
    const digest = _TypedDataEncoder.hash({name:'Gnosis Protocol',version:'v2',chainId:5042,verifyingContract:settlement}, orderTypes, order)
    const uid = hexConcat([digest,solver,hexZeroPad('0x'+order.validTo.toString(16),4)])
    const trade = [0,1,solver,input.toString(),minimum.toString(),order.validTo,order.appData,0,96,0,solver]
    const data = settle.encodeFunctionData('settle', [[usdc,eurc],[minimum.toString(),input.toString()],[trade],[[],calls,[]]])
    const probeData = abi.encode(['address','address','address','uint256','uint256','bytes','bytes'], [settlement,usdc,eurc,input.toString(),minimum.toString(),uid,data])
    const result = await rpc('eth_call', [{to:solver,data:probeData}, ref, {[solver]:{code:'0x'+runtime,balance:'0x'+(2000n*10n**18n).toString(16)}}])
    const received = BigInt(result)
    assert(received >= minimum)
    console.log(JSON.stringify({venue:name,blockHash:block.hash,input:input.toString(),minimum:minimum.toString(),received:received.toString(),settlement,transactions:0}))
  }
  const aeroQuoter = new Interface(['function quoteExactInput(address[],address,uint256) returns(uint256,uint160[],uint32[])'])
  const aeroAmount = BigInt(aeroQuoter.decodeFunctionResult('quoteExactInput', await call('0x61d0aa4a814a68f3119019f9f17aca517fea6d49', aeroQuoter.encodeFunctionData('quoteExactInput', [[pool],usdc,input.toString()])))[0].toString())
  const aeroData = execute.encodeFunctionData('execute', ['0x00',[abi.encode(['tuple(address[] pools,address tokenIn,tuple(uint8 mode,uint256 value) amountIn,bool payerIsUser,uint256 minAmountOut,address recipient)'], [[[pool],usdc,[0,input.toString()],true,aeroAmount.toString(),settlement]])],maximum])
  await probe('aero', aero, aeroAmount, [[usdc,0,token.encodeFunctionData('approve',[aero,input.toString()])],[aero,0,aeroData]])
  const cl = new Interface(['function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)', 'function exactInputSingle(tuple(address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns(uint256)'])
  const clAmount = BigInt(cl.decodeFunctionResult('quoteExactInputSingle', await call('0xc6b5c6056c4be2de1c014695a7ccb75087a1c574', cl.encodeFunctionData('quoteExactInputSingle',[[usdc,eurc,input.toString(),1,0]])))[0].toString())
  await probe('archery', archery, clAmount, [[usdc,0,token.encodeFunctionData('approve',[archery,input.toString()])],[archery,0,cl.encodeFunctionData('exactInputSingle',[[usdc,eurc,1,settlement,maximum,input.toString(),clAmount.toString(),0]])]])
  const quoter = new Interface([`function quoteExactInputSingle(tuple(${keyType} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns(uint256,uint256)`])
  const quotes = []
  for (const [fee,tick] of [[100,1],[500,10],[3000,60],[10000,200]]) {
    const key = [usdc,eurc,fee,tick,zero]
    try {
      const result = quoter.decodeFunctionResult('quoteExactInputSingle', await call('0x8dc178efb8111bb0973dd9d722ebeff267c98f94', quoter.encodeFunctionData('quoteExactInputSingle',[[key,true,input.toString(),'0x']])) )
      quotes.push({key,amount:BigInt(result[0].toString())})
    } catch(error) { if (![3,-32000].includes(error.code) || !/revert/i.test(error.message)) throw error }
  }
  quotes.sort((a,b) => a.amount > b.amount ? -1 : 1)
  assert(quotes.length && quotes[0].amount > 0n, 'No hookless v4 liquidity')
  const {key,amount} = quotes[0]
  const actions = abi.encode(['bytes','bytes[]'], ['0x060b0f',[
    abi.encode([`tuple(${keyType} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`], [[key,true,input.toString(),amount.toString(),0,'0x']]),
    abi.encode(['address','uint256','bool'], [usdc,input.toString(),false]),
    abi.encode(['address','uint256'], [eurc,amount.toString()])]])
  await probe('uniswap-v4', ur, amount, [[usdc,0,token.encodeFunctionData('transfer',[ur,input.toString()])],[ur,0,execute.encodeFunctionData('execute',['0x10',[actions],maximum])]])
  console.log(`PASS ${requests} read-only probe RPC requests; no transactions`)
}
module.exports = {main}
if (require.main === module) {
  assert(process.argv.includes('--live'), 'Explicit --live required; up to 24 public read-only RPC requests')
  main().catch(error => {console.error(error.message); process.exitCode = 1})
}
