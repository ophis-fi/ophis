// Real driver -> real solver -> deployed Arc settlement, via eth_call only.
// cargo build -p solvers -p driver --bins
// node apps/backend/crates/e2e/arc_direct.cjs --live
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const {spawn} = require('node:child_process')
const root = path.resolve(__dirname, '../../../..')
const {main: verify} = require(path.join(root,'infra/arc-mainnet/verify_direct.cjs'))
assert(process.argv.includes('--live'), 'Explicit --live required; at most 96 free public read-only RPC requests')
const settlement = '0x78799f98276efba1edeed32eae03a3fd8cdfec3a'
const solver = '0x839029e110f4954e05afad4fa222cfe93ce6d86f'
const usdc = '0x3600000000000000000000000000000000000000'
const processes = [], cache = new Map()
let reads = 0, queue = Promise.resolve(), block
async function rpc(method, params) {
  assert(['eth_chainId','eth_getBlockByNumber','eth_call','eth_getCode','eth_gasPrice','eth_getTransactionCount','eth_maxPriorityFeePerGas','eth_blockNumber'].includes(method), `Forbidden RPC: ${method}`)
  if(block && method === 'eth_getBlockByNumber') return block
  if(block && method === 'eth_blockNumber') return block.number
  if(block && ['eth_call','eth_getCode','eth_getTransactionCount'].includes(method)) params[1] = {blockHash:block.hash,requireCanonical:true}
  const key = JSON.stringify([method,params])
  if(cache.has(key)) return cache.get(key)
  const promise = queue.then(async () => {
    assert(++reads <= 96, 'Read-only RPC budget exhausted')
    await new Promise(resolve => setTimeout(resolve, 700))
    const response = await fetch('https://rpc.mainnet.arc.io', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:reads,method,params}),signal:AbortSignal.timeout(20_000)})
    assert(response.ok, `RPC HTTP ${response.status}`)
    const data = await response.json()
    if(data.error) throw data.error
    return data.result
  })
  queue = promise.catch(() => {})
  cache.set(key,promise)
  return promise
}
async function freePort() {
  const socket = net.createServer()
  await new Promise(resolve => socket.listen(0,'127.0.0.1',resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}
async function start(binary, args, port) {
  const proc = spawn(path.join(root,'apps/backend/target/debug',binary), args, {cwd:root, env:{...process.env,RUST_LOG:'error'},stdio:['ignore','pipe','pipe']})
  let log = ''
  for(const stream of [proc.stdout,proc.stderr]) stream.on('data', data => {log=(log+data).slice(-6000)})
  processes.push(proc)
  for(let attempt=0; attempt<200; attempt++) {
    assert(proc.exitCode === null, `${binary} exited: ${log}`)
    try { await fetch(`http://127.0.0.1:${port}/`, {signal:AbortSignal.timeout(200)}); return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${binary} did not start: ${log}`)
}
async function main() {
  assert.equal(await rpc('eth_chainId',[]),'0x13b2')
  block = await rpc('eth_getBlockByNumber',['latest',false])
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ophis-arc-e2e-'))
  const proxy = http.createServer(async (req,res) => {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks))
    async function response(q) {
      try { return {jsonrpc:'2.0',id:q.id,result:await rpc(q.method,q.params)} }
      catch(error) { return {jsonrpc:'2.0',id:q.id,error:{code:error.code || -32603,message:error.message || String(error),data:error.data}} }
    }
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify(Array.isArray(request) ? await Promise.all(request.map(response)) : await response(request)))
  })
  await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve))
  const rpcUrl = `http://127.0.0.1:${proxy.address().port}`
  try {
    const lanes=[]
    for(const name of ['aero','archery','uniswap-v4']) {
      const port = await freePort(), file=path.join(directory,name+'.toml')
      fs.writeFileSync(file, `node-url = "${rpcUrl}"
settlement = "${settlement}"
wrapped-native = "${usdc}"
concurrent-requests = 1
internalize-interactions = false
strict-output-simulation = true
strict-market-output-simulation = "all"
[dex]
chain-id = "5042"
venue = "${name}"
`, {mode:0o600})
      await start('solvers',['--addr',`127.0.0.1:${port}`,name==='archery'?'directv3':'arc','--config',file],port)
      lanes.push(`[[solver]]
name = "${name}"
endpoint = "http://127.0.0.1:${port}"
account = "${solver}"
relative-slippage = "0.01"
skip-liquidity = true
manage-native-token = {wrap-address = false, insert-unwraps = false}
`)
    }
    const port=await freePort(),file=path.join(directory,'driver.toml')
    fs.writeFileSync(file, `chain-id = 5042
tx-gas-limit = "5000000"
gas-estimator = {estimator = "web3"}
disable-access-list-simulation = true
[contracts]
gp-v2-settlement = "${settlement}"
weth = "${usdc}"
balances = "0x5f315A204E7971fC29a66fef3a5773f6B0202fac"
signatures = "0x2FbB1e41fF4f9b707E4428EEC7F5AFAaC5D60810"
${lanes.join('\n')}
[[submission.mempool]]
url = "${rpcUrl}"
additional-tip-percentage = 0.0
`, {mode:0o600})
    await start('driver',['--addr',`127.0.0.1:${port}`,'--ethrpc',rpcUrl,'--block-stream-poll-interval','60s','--ethrpc-max-concurrent-requests','2','--config',file],port)
    await verify({rpcUrl,driverUrl:`http://127.0.0.1:${port}`})
    console.log(`PASS driver -> solver -> settlement: 3 venues, ${reads} public reads, zero signed/broadcast transactions`)
  } finally {
    for(const proc of processes) proc.kill('SIGTERM')
    proxy.closeAllConnections()
    await new Promise(resolve => proxy.close(resolve))
    // Only this invocation's disposable, keyless configurations.
    fs.rmSync(directory,{recursive:true})
  }
}
main().catch(error => {console.error(error);process.exitCode=1})
