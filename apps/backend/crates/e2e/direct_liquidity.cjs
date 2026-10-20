// Real driver -> Rust connector -> deployed GPv2 settlement; eth_call only.
// Prerequisites: cargo build -p driver -p solvers --bins, solc 0.8.30 and installed frontend deps.
// E2E_BIN_DIR=<target/debug> NODE_PATH=<frontend/node_modules/.pnpm/node_modules> node apps/backend/crates/e2e/direct_liquidity.cjs --live
// State overrides fund a disposable ERC-1271 trader and solver; real Robinhood authorization is retained.
// No signatures, transactions or database. At most 400 reads per scenario, 800 total.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const {spawn, execFileSync} = require('node:child_process')
const {Interface, defaultAbiCoder: abi} = require('@ethersproject/abi')
const {_TypedDataEncoder} = require('@ethersproject/hash')
const {hexConcat, hexZeroPad} = require('@ethersproject/bytes')
const {keccak256} = require('@ethersproject/keccak256')
const root = path.resolve(__dirname, '../../../..')
const bin = process.env.E2E_BIN_DIR || path.join(root, 'apps/backend/target/debug')
const owner = '0x1000000000000000000000000000000000000001'
const solver = '0x95f0beab29bea3d18a7c81140aed9227ff2d7665'
const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const zero = '0x' + '00'.repeat(32)
const token = new Interface(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)'])
const settlementAbi = new Interface(['function vaultRelayer() view returns(address)'])
const orderTypes = {Order: [['sellToken','address'],['buyToken','address'],['receiver','address'],['sellAmount','uint256'],['buyAmount','uint256'],['validTo','uint32'],['appData','bytes32'],['feeAmount','uint256'],['kind','string'],['partiallyFillable','bool'],['sellTokenBalance','string'],['buyTokenBalance','string']].map(([name,type]) => ({name,type}))}
const probeSource = `pragma solidity ^0.8.30;
interface Token { function balanceOf(address) external view returns(uint256); }
contract Probe {
 fallback(bytes calldata data) external returns(bytes memory) {
  (address settlement,address sell,address buy,address owner,address weth,uint256 input,uint256 minimum,bytes memory callData)=abi.decode(data,(address,address,address,address,address,uint256,uint256,bytes));
  uint256[5] memory beforeBalances=[Token(sell).balanceOf(owner),buy==address(0) ? owner.balance : Token(buy).balanceOf(owner),
   Token(sell).balanceOf(settlement),buy==address(0) ? settlement.balance : Token(buy).balanceOf(settlement),buy==address(0) ? Token(weth).balanceOf(settlement) : 0];
  (bool ok,bytes memory result)=settlement.call(callData);
  if(!ok) assembly { revert(add(result,32),mload(result)) }
  uint256 received=(buy==address(0) ? owner.balance : Token(buy).balanceOf(owner))-beforeBalances[1];
  require(beforeBalances[0]-Token(sell).balanceOf(owner)==input,"input mismatch");
  require(received>=minimum,"output shortfall");
  require(Token(sell).balanceOf(settlement)>=beforeBalances[2],"sell buffer depleted");
  require((buy==address(0) ? settlement.balance : Token(buy).balanceOf(settlement))>=beforeBalances[3],"buy buffer depleted");
  if(buy==address(0)) require(Token(weth).balanceOf(settlement)>=beforeBalances[4],"WETH buffer depleted");
  return abi.encode(received);
 }
}`
const compiler = process.env.SOLC || path.join(os.homedir(), '.solc-select/artifacts/solc-0.8.30/solc-0.8.30')
const compiled = JSON.parse(execFileSync(compiler, ['--standard-json'], {input:JSON.stringify({language:'Solidity',sources:{'Probe.sol':{content:probeSource}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['evm.deployedBytecode.object']}}}}),encoding:'utf8'}))
assert(!(compiled.errors || []).some(e => e.severity === 'error'), 'Probe compilation failed')
const probe = '0x' + compiled.contracts['Probe.sol'].Probe.evm.deployedBytecode.object

async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function listen(server) {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  return `http://127.0.0.1:${server.address().port}`
}
async function jsonRequest(url, body, expectedStatus = 200) {
  const response = await fetch(url,{method:'POST',headers:{'content-type':'application/json',...(body.orders?{'x-auction-id':body.id}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(60_000)})
  const result = await response.json()
  assert.equal(response.status,expectedStatus,`HTTP ${response.status}: ${JSON.stringify(result)}`)
  return result
}
async function run(chain) {
  const processes = [], servers = [], cache = new Map()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ophis-direct-e2e-'))
  let reads = 0, block, fixture = {}, mutate = false, mutations = 0, connectorResponses = 0
  const fees = new Map()
  async function rpc(method, params) {
    assert(/^(eth_chainId|eth_getBlockByNumber|eth_getBlockByHash|eth_call|eth_getCode|eth_gasPrice|eth_getBalance|eth_getTransactionCount|eth_maxPriorityFeePerGas|eth_blockNumber|eth_estimateGas|eth_getStorageAt)$/.test(method), `Forbidden RPC: ${method}`)
    params = structuredClone(params)
    if(block && ['eth_getBlockByNumber','eth_getBlockByHash'].includes(method)) return block
    if(block && method === 'eth_blockNumber') return block.number
    if(method === 'eth_getBalance' && params[0].toLowerCase()===solver) return fixture[solver].balance
    if(block && method === 'eth_estimateGas') params[1] = block.number
    if(block && ['eth_call','eth_getCode','eth_getBalance','eth_getTransactionCount','eth_getStorageAt'].includes(method)) params[method === 'eth_getStorageAt' ? 2 : 1] = {blockHash:block.hash,requireCanonical:true}
    if(method === 'eth_call' || method === 'eth_estimateGas') {
      const combined = structuredClone(fixture)
      for(const [address, override] of Object.entries(params[2] || {})) combined[address] = {...combined[address],...override,stateDiff:{...combined[address]?.stateDiff,...override.stateDiff}}
      params[2] = combined
    }
    const key = JSON.stringify([method,params])
    if(cache.has(key)) return cache.get(key)
    const promise = (async () => {
      assert(++reads <= 400, 'Read-only RPC budget exhausted')
      const response = await jsonRequest(chain.rpc,{jsonrpc:'2.0',id:reads,method,params})
      if(response.error) throw response.error
      return response.result
    })()
    cache.set(key,promise)
    return promise
  }
  async function start(binary, args, port) {
    const env = {...process.env, OPHIS_INTER_SERVICE_AUTH_TOKEN:'', LOG_FILTER:'warn', RUST_LOG:'warn'}
    const proc = spawn(path.join(bin,binary),args,{cwd:root,env,stdio:['ignore','pipe','pipe']})
    let log = ''
    proc.rejections = new Set()
    for(const stream of [proc.stdout,proc.stderr]) stream.on('data',chunk => {
      log=(log+chunk).slice(-5000)
      for(const match of log.matchAll(/rejecting Custom interaction from solver solver=([a-z-]+) chain_id=\d+ reason="calldata_not_allowed"/g))proc.rejections.add(match[1])
    })
    proc.testLog = () => log
    processes.push(proc)
    for(let i=0;i<300;i++) {
      assert(proc.exitCode === null, `${binary} exited: ${log}`)
      try {await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(200)});return proc} catch {}
      await new Promise(resolve => setTimeout(resolve,100))
    }
    throw new Error(`${binary} startup timeout: ${log}`)
  }
  try {
    assert.equal(Number(BigInt(await rpc('eth_chainId',[]))),chain.id)
    block = await rpc('eth_getBlockByNumber',['latest',false])
    console.log(`STATE chain=${chain.id} block=${Number(BigInt(block.number))} hash=${block.hash} nativeBuy=${chain.buy===native} authenticator=unchanged`)
    const relayer = settlementAbi.decodeFunctionResult('vaultRelayer',await rpc('eth_call',[{to:chain.settlement,data:settlementAbi.encodeFunctionData('vaultRelayer')},'latest']))[0]
    const funded = 10n ** 18n
    const fundedWord = hexZeroPad('0x'+funded.toString(16),32)
    const balanceSlot = keccak256(abi.encode(['address','uint256'],[owner,chain.slot]))
    const allowanceSlot = keccak256(abi.encode(['address','bytes32'],[relayer,keccak256(abi.encode(['address','uint256'],[owner,chain.allowanceSlot]))]))
    fixture = {[owner]:{code:'0x631626ba7e60e01b60005260206000f3',balance:'0x1'},[solver]:{balance:'0x56bc75e2d63100000'},[chain.sell]:{stateDiff:{[balanceSlot]:fundedWord,[allowanceSlot]:fundedWord}}}
    assert.equal(BigInt(await rpc('eth_call',[{to:chain.sell,data:token.encodeFunctionData('balanceOf',[owner])},'latest'])),funded,'Balance override slot must be independently checked')
    assert.equal(BigInt(await rpc('eth_call',[{to:chain.sell,data:token.encodeFunctionData('allowance',[owner,relayer])},'latest'])),funded,'Allowance override slot must be independently checked')
    const rpcServer = http.createServer(async (req,res) => {
      const chunks=[];for await(const chunk of req)chunks.push(chunk)
      const request=JSON.parse(Buffer.concat(chunks))
      const respond=async q => {try{return {jsonrpc:'2.0',id:q.id,result:await rpc(q.method,q.params)}}catch(e){return {jsonrpc:'2.0',id:q.id,error:{code:e.code || -32603,message:e.message || String(e),data:e.data}}}}
      res.setHeader('content-type','application/json')
      res.end(JSON.stringify(Array.isArray(request)?await Promise.all(request.map(respond)):await respond(request)))
    })
    servers.push(rpcServer)
    const rpcUrl=await listen(rpcServer), lanes=[]
    for(const name of chain.lanes) {
      const port=await freePort(),file=path.join(directory,name+'.toml')
      const dex=`\nchain-id="${chain.id}"`
      fs.writeFileSync(file,`node-url="${rpcUrl}"\nsettlement="${chain.settlement}"\nwrapped-native="${chain.weth}"\nwrapped-native-balance-slot=${chain.wethSlot}\nstrict-output-simulation=true\nstrict-market-output-simulation="all"\ninternalize-interactions=false\n[dex]${dex}\n`,{mode:0o600})
      await start('solvers',['--addr',`127.0.0.1:${port}`,name,'--config',file],port)
      const relay=http.createServer(async(req,res)=>{
        try {
        const chunks=[];for await(const chunk of req)chunks.push(chunk)
        const response=await fetch(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers:{'content-type':'application/json'},body:Buffer.concat(chunks),signal:AbortSignal.timeout(55_000)})
        const result=await response.json()
        if(result.solutions?.length)connectorResponses++
        for(const solution of result.solutions || []) {
          const fee=BigInt(solution.trades[0]?.fee || '0')
          assert(fee>0n,`${name}: exercise a nonzero solver fee`)
          fees.set(name,fee)
        }
        if(mutate)for(const solution of result.solutions || [])for(const call of solution.interactions || [])if(call.kind==='custom'){
          // Lower only the encoded router floor; the reported output and clearing prices stay intact.
          const offset=name==='metric'?4+6*32:4+3*32
          const minimum=BigInt('0x'+call.callData.slice(2+offset*2,2+(offset+32)*2))
          assert(minimum>1n,'Mutation must keep a nonzero floor')
          call.callData=call.callData.slice(0,2+offset*2)+hexZeroPad('0x'+(minimum-1n).toString(16),32).slice(2)+call.callData.slice(2+(offset+32)*2)
          mutations++
        }
        res.setHeader('content-type','application/json');res.end(JSON.stringify(result))
        } catch(error) {res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}))}
      })
      servers.push(relay)
      const endpoint=await listen(relay)
      lanes.push(`[[solver]]\nname="${name}"\nendpoint="${endpoint}"\naccount="${solver}"\nrelative-slippage="0.01"\nskip-liquidity=true\n`)
    }
    const port=await freePort(),file=path.join(directory,'driver.toml')
    fs.writeFileSync(file,`chain-id=${chain.id}\ntx-gas-limit="15000000"\ngas-estimator={estimator="web3"}\ndisable-access-list-simulation=true\n[contracts]\ngp-v2-settlement="${chain.settlement}"\nweth="${chain.weth}"\nbalances="0x5f315a204e7971fc29a66fef3a5773f6b0202fac"\nsignatures="0x2fbb1e41ff4f9b707e4428eec7f5afaac5d60810"\n${lanes.join('\n')}\n[[submission.mempool]]\nurl="${rpcUrl}"\nadditional-tip-percentage=0.0\n`,{mode:0o600})
    const driver=await start('driver',['--addr',`127.0.0.1:${port}`,'--ethrpc',rpcUrl,'--block-stream-poll-interval','60s','--config',file],port)
    let auction=1
    for(const name of chain.lanes) {
      const validTo=Math.floor(Date.now()/1000)+3600
      const order={sellToken:chain.sell,buyToken:chain.buy,receiver:owner,sellAmount:chain.input,buyAmount:'1',validTo,appData:zero,feeAmount:'0',kind:'sell',partiallyFillable:false,sellTokenBalance:'erc20',buyTokenBalance:'erc20'}
      const digest=_TypedDataEncoder.hash({name:'Gnosis Protocol',version:'v2',chainId:chain.id,verifyingContract:chain.settlement},orderTypes,order)
      const uid=hexConcat([digest,owner,hexZeroPad('0x'+validTo.toString(16),4)])
      const request=()=>({id:String(auction++),tokens:[{address:chain.sell,price:chain.sellPrice,trusted:true},{address:chain.buy===native?chain.weth:chain.buy,price:chain.buyPrice,trusted:true}],orders:[{...order,uid,owner,protocolFees:[],created:Math.floor(Date.now()/1000),executed:'0',preInteractions:[],postInteractions:[],class:'limit',signingScheme:'eip1271',signature:'0x',quote:null}],deadline:new Date(Date.now()+20_000).toISOString(),surplusCapturingJitOrderOwners:[]})
      mutate=true
      const before=mutations
      const rejected=await jsonRequest(`http://127.0.0.1:${port}/${name}/solve`,request(),400)
      assert(mutations>before,`${name}: mutation must reach an actual connector solution`)
      assert.equal(rejected.kind,'SolverFailed',`${name}: lowered router floor must be rejected`)
      await new Promise(resolve=>setImmediate(resolve))
      assert(driver.rejections.has(name),`${name}: driver must reject the custom calldata`)
      mutate=false
      const goodRequest=request(),solved=await jsonRequest(`http://127.0.0.1:${port}/${name}/solve`,goodRequest)
      assert(solved.solutions.length>0,`${name}: funded real solve must succeed`)
      const solution=solved.solutions[0],trade=solution.orders[uid]
      assert(trade && BigInt(trade.executedBuy)>0n)
      const revealed=await jsonRequest(`http://127.0.0.1:${port}/${name}/reveal`,{solutionId:solution.solutionId,auctionId:goodRequest.id})
      const result=await rpc('eth_call',[{from:solver,to:solver,data:abi.encode(['address','address','address','address','address','uint256','uint256','bytes'],[chain.settlement,chain.sell,chain.buy===native?'0x'+'00'.repeat(20):chain.buy,owner,chain.weth,trade.executedSell,trade.executedBuy,revealed.calldata.uninternalized]),gas:'0xe4e1c0'},'latest',{[solver]:{code:probe}}])
      assert(BigInt(result)>=BigInt(trade.executedBuy))
      console.log(`PASS ${chain.id}/${name}: real solve, fee ${fees.get(name)}, rejected floor mutation, revealed settlement output ${BigInt(result)}`)
    }
    assert(connectorResponses>=chain.lanes.length*2)
    console.log(`PASS chain ${chain.id}: ${reads} read-only RPC requests; zero transactions`)
  } catch(error) {
    for(const proc of processes)console.error(proc.testLog())
    throw error
  } finally {
    for(const proc of processes)proc.kill('SIGTERM')
    for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
    fs.rmSync(directory,{recursive:true})
  }
}
async function main() {
  assert.deepEqual(process.argv.slice(2),['--live'],'Explicit --live required; at most 400 reads per scenario, 800 total')
  await run({id:4663,rpc:process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com',settlement:'0x886d9fd312f442c4e1f3cdeae7b4ab73493e57cd',weth:'0x0bd7d308f8e1639fab988df18a8011f41eacad73',wethSlot:51,sell:'0x0bd7d308f8e1639fab988df18a8011f41eacad73',buy:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',slot:51,allowanceSlot:52,input:'100000000000000',sellPrice:'1000000000000000000',buyPrice:'500000000000000000000000000',lanes:['metric','elfomo']})
  await run({id:4663,rpc:process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com',settlement:'0x886d9fd312f442c4e1f3cdeae7b4ab73493e57cd',weth:'0x0bd7d308f8e1639fab988df18a8011f41eacad73',wethSlot:51,sell:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',buy:native,slot:1,allowanceSlot:3,input:'1000000',sellPrice:'500000000000000000000000000',buyPrice:'1000000000000000000',lanes:['metric']})
}
main().catch(error=>{console.error(error);process.exitCode=1})
