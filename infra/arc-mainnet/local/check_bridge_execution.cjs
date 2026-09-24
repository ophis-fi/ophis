// Execute the recorded SDK hook on a disposable, non-forked local Base chain.
// Real committed Weiroll VM; fixture host/token/Spoke and local math reimplementation.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../../..')
const dependency = createRequire(path.join(root, 'apps/frontend/apps/cowswap-frontend/package.json'))
const { StaticJsonRpcProvider } = dependency('@ethersproject/providers')
const { Contract } = dependency('@ethersproject/contracts')
const { Interface, defaultAbiCoder } = dependency('@ethersproject/abi')
const { keccak256 } = dependency('@ethersproject/keccak256')
const { getCreate2Address } = dependency('@ethersproject/address')
const generated = path.join(__dirname, 'generated')
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SPOKE = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64'
const PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const VM = '0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963'
const MATH = '0xd4e943dc6ddc885f6229ce33c2e3dfe402a12c81'
const same = (a,b) => assert.equal(a.toLowerCase(), b.toLowerCase())
const wait = ms => new Promise(resolve => setTimeout(resolve,ms))
const compile = (version, files) => JSON.parse(execFileSync(
  path.join(process.env.HOME,'.solc-select/artifacts',`solc-${version}`,`solc-${version}`),
  ['--base-path','.', '--optimize','--via-ir','--evm-version','shanghai','--combined-json','abi,bin-runtime',...files],
  {cwd:root,encoding:'utf8',maxBuffer:8*1024*1024})).contracts

async function main() {
  assert.equal(process.argv.length,2,'No endpoint or signer arguments permitted')
  const probe = net.createServer()
  await new Promise((resolve,reject) => { probe.once('error',reject); probe.listen(31557,'127.0.0.1',resolve) })
  await new Promise(resolve => probe.close(resolve))
  const record = JSON.parse(fs.readFileSync(path.join(generated,'bridge-result.json')))
  const fees = JSON.parse(fs.readFileSync(path.join(generated,'across-fees-live.json'))).response
  assert.equal(record.originChainId,8453); assert.equal(record.destinationChainId,5042)
  same(record.unsignedCall.to,VM); assert.equal(record.unsignedCall.value,'0')
  const fixtures = compile('0.8.28',['infra/arc-mainnet/local/BridgeExecutionFixtures.sol','contracts/src/contracts/AcrossMathHelper.sol'])
  const tokenArtifact = compile('0.8.30',['infra/arc-mainnet/local/Fixtures.sol'])['infra/arc-mainnet/local/Fixtures.sol:LocalEURC']
  const artifact = name => fixtures[`infra/arc-mainnet/local/BridgeExecutionFixtures.sol:${name}`]
  const vmAbi = new Interface(['function execute(bytes32[] commands,bytes[] state)'])
  const {commands,state} = vmAbi.decodeFunctionData('execute',record.unsignedCall.data)
  const hostAddress = defaultAbiCoder.decode(['address'],state[0])[0]
  const log = fs.openSync(path.join(generated,'bridge-execution-anvil.log'),'w')
  const child = spawn(path.join(process.env.HOME,'.foundry/bin/anvil'),[
    '--host','127.0.0.1','--port','31557','--chain-id','8453','--timestamp',String(fees.timestamp),'--silent',
  ],{stdio:['ignore',log,log]})
  fs.closeSync(log)
  const stopped = once(child,'exit')
  const provider = new StaticJsonRpcProvider('http://127.0.0.1:31557',8453)
  provider.pollingInterval=100
  let signal
  const stop = () => { signal=true; child.kill('SIGTERM') }
  process.once('SIGINT',stop); process.once('SIGTERM',stop)
  try {
    let ready=false
    for(let i=0;i<100 && child.exitCode===null && !signal;i++) {
      try { await provider.send('web3_clientVersion',[]); ready=true; break } catch { await wait(50) }
    }
    assert(ready,'Owned Anvil did not start')
    assert.match(await provider.send('web3_clientVersion',[]),/anvil/i)
    assert.equal(await provider.send('eth_chainId',[]),'0x2105')
    assert.equal(Number(await provider.getBlockNumber()),0,'Must own a fresh chain')
    const info = await provider.send('anvil_nodeInfo',[])
    assert(!info.forkConfig?.forkUrl,'Forks prohibited')
    const signer = provider.getSigner(0)
    const put = (address,art) => provider.send('anvil_setCode',[address,'0x'+art['bin-runtime']])
    await put(USDC,tokenArtifact); await put(SPOKE,artifact('LocalSpokePool'))
    await put(hostAddress,artifact('LocalBridgeHost')); await put(PROXY,artifact('LocalCreate2Proxy'))
    await put(MATH,fixtures['contracts/src/contracts/AcrossMathHelper.sol:AcrossMathHelper'])
    const initcode=fs.readFileSync(path.join(root,'contracts/script/weiroll/WeirollVM.initcode'),'utf8').trim()
    const salt='0x'+'00'.repeat(32)
    assert.equal(keccak256(initcode),'0xe75ac6f040cd215056d2bc738bcd01734bd61386858d685a8d95084e87bc66ed')
    same(getCreate2Address(PROXY,salt,keccak256(initcode)),VM)
    await (await signer.sendTransaction({to:PROXY,data:salt+initcode.slice(2),gasLimit:3000000})).wait()
    assert.notEqual(await provider.getCode(VM),'0x')
    const token = new Contract(USDC,tokenArtifact.abi,signer)
    const spoke = new Contract(SPOKE,artifact('LocalSpokePool').abi,signer)
    const host = new Contract(hostAddress,artifact('LocalBridgeHost').abi,signer)
    const amount=BigInt(record.input)
    await (await token.mint(hostAddress,amount.toString())).wait()
    const receipt=await (await host.run(VM,record.unsignedCall.data,{gasLimit:2000000})).wait()
    const event=receipt.logs.filter(log => log.address.toLowerCase()===SPOKE.toLowerCase()).map(log => spoke.interface.parseLog(log)).find(log => log.name==='Deposit')
    assert(event,'Spoke deposit must occur'); same(event.args.caller,hostAddress)
    const types=['address','address','address','address','uint256','uint256','uint256','address','uint32','uint32','uint32','bytes']
    const args=defaultAbiCoder.decode(types,event.args.arguments)
    same(args[0],hostAddress); same(args[1],'0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
    same(args[2],USDC); same(args[3],'0x3600000000000000000000000000000000000000')
    assert.equal(args[4].toString(),record.input)
    assert.equal(args[5].toString(),(amount-amount*BigInt(fees.totalRelayFee.pct)/10n**18n).toString())
    assert.equal(args[5].toString(),record.output); assert.equal(args[6].toString(),'5042')
    same(args[7],fees.exclusiveRelayer)
    for (const [i,key] of [[8,'timestamp'],[9,'fillDeadline'],[10,'exclusivityDeadline']]) assert.equal(args[i],Number(fees[key]))
    assert.equal(args[11],'0x')
    assert.equal((await token.balanceOf(hostAddress)).toString(),'0')
    assert.equal((await token.balanceOf(SPOKE)).toString(),record.input)
    assert.equal((await token.allowance(hostAddress,SPOKE)).toString(),'0')
    assert.equal((await spoke.deposits()).toString(),'1')
    // A fresh funding amount must survive either downstream failure unchanged.
    await (await token.mint(hostAddress,amount.toString())).wait()
    const assertAtomicFailure=async data => {
      const tx=await host.run(VM,data,{gasLimit:2000000})
      await assert.rejects(tx.wait(),error => error.receipt?.status===0)
      assert.equal((await token.balanceOf(hostAddress)).toString(),record.input)
      assert.equal((await token.balanceOf(SPOKE)).toString(),record.input)
      assert.equal((await token.allowance(hostAddress,SPOKE)).toString(),'0')
      assert.equal((await spoke.deposits()).toString(),'1')
    }
    const expired=[...state]
    const fillIndex=Buffer.from(commands[4].slice(2),'hex')[9]&127
    expired[fillIndex]=defaultAbiCoder.encode(['uint32'],[Number(fees.timestamp)-1])
    await assertAtomicFailure(vmAbi.encodeFunctionData('execute',[commands,expired]))
    await (await spoke.setFail(true)).wait()
    await assertAtomicFailure(record.unsignedCall.data)
    const result={localOnly:true,fixtureChainId:8453,destinationChainId:5042,
      weirollInitcodeHash:keccak256(initcode),successTransaction:receipt.transactionHash,
      input:record.input,output:record.output,expiredDeadlineAtomic:true,spokeRevertAtomic:true,
      fixtures:['CoWShed execution host','ERC20 source token','SpokePool','CREATE2 proxy','compiled AcrossMathHelper reimplementation'],
      externalRpcRequests:0,liveBridgeFill:false}
    fs.writeFileSync(path.join(generated,'bridge-execution-result.json'),JSON.stringify(result,null,2)+'\n')
    console.log('PASS: committed Weiroll VM executed recorded Base -> Arc SDK hook locally; exact deposit arguments, token pull, zero residual allowance, expired-deadline and post-transfer revert atomicity. Fixtures only; no live bridge fill.')
  } finally {
    process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop)
    child.kill('SIGTERM')
    if(child.exitCode===null) await stopped
  }
}
main().catch(error => { console.error(error); process.exitCode=1 })
