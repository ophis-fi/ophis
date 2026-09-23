// Build and inspect the existing SDK's unsigned Base -> Arc hook. Never sign/send.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const dependency = createRequire(path.resolve(__dirname, '../../../apps/frontend/apps/cowswap-frontend/package.json'))
const { AcrossBridgeProvider } = dependency('@cowprotocol/sdk-bridging')
const { EthersV5Adapter } = dependency('@cowprotocol/sdk-ethers-v5-adapter')
const { StaticJsonRpcProvider } = dependency('@ethersproject/providers')
const { Interface, defaultAbiCoder } = dependency('@ethersproject/abi')
const live = process.argv.includes('--live')
assert(process.argv.slice(2).every(arg => arg === '--live'))
const output = path.join(__dirname, 'generated')
const recordPath = path.join(output, 'across-fees-live.json')
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ARC_USDC = '0x3600000000000000000000000000000000000000'
// First-party Across chain table: https://docs.across.to/chains-and-contracts
const BASE_SPOKE = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64'
const ARC_SPOKE = '0x9b4A302A548c7e313c2b74C461db7b84d3074A84'
const account = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const same = (left, right) => assert.equal(left.toLowerCase(), right.toLowerCase())

async function main() {
  const rpc = new StaticJsonRpcProvider('http://127.0.0.1:1', 8453)
  rpc.send = async () => { throw Error('Bridge build must make zero RPC calls') }
  const provider = new AcrossBridgeProvider({apiOptions:{integratorId:'0x0311'}}, new EthersV5Adapter({provider:rpc}))
  const request = {kind:'sell', account, receiver:account, sellTokenChainId:8453, buyTokenChainId:5042,
    sellTokenAddress:BASE_USDC, buyTokenAddress:ARC_USDC, sellTokenDecimals:6, buyTokenDecimals:6, amount:100000000n}
  const originalFetch = global.fetch
  let requests = 0
  let recorded
  global.fetch = async (input, options) => {
    const url = new URL(String(input))
    assert(++requests <= 1, 'At most one quote API call; no retries')
    assert.equal(url.origin, 'https://app.across.to')
    assert.equal(url.pathname, '/api/suggested-fees')
    assert(!options?.method || options.method === 'GET')
    for (const [key,value] of Object.entries({originChainId:'8453', destinationChainId:'5042',
      inputToken:BASE_USDC, outputToken:ARC_USDC, amount:'100000000', integratorId:'0x0311'})) {
      same(url.searchParams.get(key),value)
    }
    if (!live) {
      recorded = JSON.parse(fs.readFileSync(recordPath))
      return new Response(JSON.stringify(recorded.response), {status:200, headers:{'Content-Type':'application/json'}})
    }
    const response = await originalFetch(input, {...options, signal:AbortSignal.timeout(20000)})
    assert(response.ok, `Across quote returned HTTP ${response.status}`)
    recorded = {url:String(input), fetchedAt:new Date().toISOString(), response:await response.clone().json()}
    fs.writeFileSync(recordPath, JSON.stringify(recorded,null,2)+'\n')
    return response
  }
  try {
    const quote = await provider.getQuote(request)
    const fees = quote.suggestedFees
    same(fees.spokePoolAddress,BASE_SPOKE)
    same(recorded.response.destinationSpokePoolAddress,ARC_SPOKE)
    for (const [field,address,chainId] of [['inputToken',BASE_USDC,8453],['outputToken',ARC_USDC,5042]]) {
      same(recorded.response[field].address,address)
      assert.equal(recorded.response[field].chainId,chainId)
      assert.equal(recorded.response[field].decimals,6)
    }
    assert.equal(fees.isAmountTooLow,false)
    assert(request.amount >= BigInt(fees.limits.minDeposit) && request.amount <= BigInt(fees.limits.maxDeposit))
    if (live) assert(Math.abs(Date.now()/1000-Number(fees.timestamp)) < 600, 'Quote must be fresh')
    const expected = request.amount - request.amount * BigInt(fees.totalRelayFee.pct) / 10n**18n
    assert.equal(quote.amountsAndCosts.afterFee.buyAmount,expected)
    assert.equal(expected,BigInt(recorded.response.outputAmount))
    const call = await provider.getUnsignedBridgeCall(request,quote)
    assert.equal(call.value,0n)
    same(call.to,'0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963')
    const executor = new Interface(['function execute(bytes32[] commands,bytes[] state)'])
    const {commands,state} = executor.decodeFunctionData('execute',call.data)
    assert.equal(commands.length,5) // Four calls; depositV3 uses two command words.
    const command = (index, extended=false) => {
      const bytes = Buffer.from(commands[index].slice(2),'hex')
      return {selector:'0x'+bytes.subarray(0,4).toString('hex'),flags:bytes[4],result:bytes[11],
        target:'0x'+bytes.subarray(12).toString('hex'),
        args:extended ? [...Buffer.from(commands[index+1].slice(2),'hex')] : [...bytes.subarray(5,11)]}
    }
    const balance = command(0), math = command(1), approval = command(2), deposit = command(3,true)
    const literal = (cmd,index,type) => defaultAbiCoder.decode([type],state[cmd.args[index] & 127])[0]
    assert.equal(balance.selector,'0x70a08231'); same(balance.target,BASE_USDC); assert.equal(balance.flags,2)
    same(math.target,'0xd4e943dc6ddc885f6229ce33c2e3dfe402a12c81')
    const mathAbi = new Interface(['function multiplyAndSubtract(uint256,uint256) returns(uint256)'])
    assert.equal(math.selector,mathAbi.getSighash('multiplyAndSubtract')); assert.equal(math.flags,1)
    assert.equal(math.args[0],balance.result)
    assert.equal(literal(math,1,'uint256').toString(),fees.totalRelayFee.pct)
    assert.equal(approval.selector,'0x095ea7b3'); same(approval.target,BASE_USDC); assert.equal(approval.flags,1)
    same(literal(approval,0,'address'),BASE_SPOKE); assert.equal(approval.args[1],balance.result)
    const abi = new Interface(['function depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)'])
    assert.equal(deposit.selector,abi.getSighash('depositV3')); same(deposit.target,BASE_SPOKE)
    assert.equal(deposit.flags,65)
    same(literal(deposit,0,'address'),literal(balance,0,'address'))
    same(literal(deposit,1,'address'),account)
    same(literal(deposit,2,'address'),BASE_USDC); same(literal(deposit,3,'address'),ARC_USDC)
    assert.equal(deposit.args[4],balance.result); assert.equal(deposit.args[5],math.result)
    assert.equal(literal(deposit,6,'uint256').toString(),'5042')
    same(literal(deposit,7,'address'),fees.exclusiveRelayer)
    for (const [index,field] of [[8,'timestamp'],[9,'fillDeadline'],[10,'exclusivityDeadline']]) {
      assert.equal(literal(deposit,index,'uint32'),Number(fees[field]))
    }
    assert.equal(state[deposit.args[11] & 127],'0x'+'0'.repeat(64))
    const result = {live, fetchedAt:recorded.fetchedAt, originChainId:8453,destinationChainId:5042,
      input:'100000000',output:expected.toString(),apiRequests:live ? requests : 0,rpcRequests:0,unsignedCall:call}
    fs.writeFileSync(path.join(output,'bridge-result.json'),JSON.stringify(result,(_,v)=>typeof v === 'bigint'? v.toString():v,2)+'\n')
    console.log(`PASS: ${live ? 'live' : 'recorded'} Across quote and unsigned SDK hook; exact pair, amounts, recipient, deadlines, spender and source SpokePool verified; no signing or RPC`)
  } finally { global.fetch = originalFetch }
}
main().catch(error => { console.error(error); process.exitCode=1 })
