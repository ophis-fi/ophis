// Full UI corridor with local source/relayer fixtures and the real Arc backend.
// All public requests are intercepted or blocked. Never accepts remote RPC/key arguments.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../../..')
const frontend = path.join(root, 'apps/frontend')
const dependency = createRequire(path.join(frontend, 'apps/cowswap-frontend/package.json'))
const { JsonRpcProvider } = dependency('@ethersproject/providers')
const { Contract, ContractFactory } = dependency('@ethersproject/contracts')
const { _TypedDataEncoder } = dependency('@ethersproject/hash')
const { verifyTypedData } = dependency('@ethersproject/wallet')
const { hexConcat, hexZeroPad, hexlify } = dependency('@ethersproject/bytes')
const { getCreate2Address } = dependency('@ethersproject/address')
const { keccak256 } = dependency('@ethersproject/keccak256')
const { toUtf8Bytes } = dependency('@ethersproject/strings')
const store = path.join(frontend, 'node_modules/.pnpm')
const playwright = fs.readdirSync(store).find(name => name.startsWith('playwright@'))
const { chromium } = require(path.join(store, playwright, 'node_modules/playwright'))
const out = path.join(__dirname, 'generated')
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'deployment.json')))
const read = file => JSON.parse(fs.readFileSync(file))
const WETH = '0x4200000000000000000000000000000000000006'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ARC_USDC = '0x3600000000000000000000000000000000000000'
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
const SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
const RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
const SPOKE = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64'
const FACTORY = '0x312f92fe5f1710408B20D52A374fa29e099cFA86'
const VM = '0x9585c3062Df1C247d5E373Cfca9167F7dC2b5963'
const PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const MATH = '0xd4e943dc6ddc885f6229ce33c2e3dfe402a12c81'
const ZERO = '0x'+'0'.repeat(40)
const same = (a,b) => assert.equal(a.toLowerCase(), b.toLowerCase())
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const compile = (version, files) => JSON.parse(execFileSync(
  path.join(process.env.HOME, '.solc-select/artifacts', `solc-${version}`, `solc-${version}`),
  ['--base-path','.', '--optimize','--via-ir','--evm-version','shanghai','--combined-json','abi,bin-runtime',...files],
  {cwd:root,encoding:'utf8',maxBuffer:8*1024*1024})).contracts
const orderTypes = {Order:[['sellToken','address'],['buyToken','address'],['receiver','address'],['sellAmount','uint256'],
  ['buyAmount','uint256'],['validTo','uint32'],['appData','bytes32'],['feeAmount','uint256'],['kind','string'],
  ['partiallyFillable','bool'],['sellTokenBalance','string'],['buyTokenBalance','string']].map(([name,type]) => ({name,type}))}

async function main() {
  assert.equal(process.argv.length, 2)
  assert(manifest.localOnly && manifest.automaticSettlement && manifest.chainId === 5042)
  const arc = new JsonRpcProvider('http://127.0.0.1:8547', 5042)
  arc.pollingInterval=100
  assert.equal(await arc.send('eth_chainId',[]),'0x13b2')
  assert.match(await arc.send('web3_clientVersion',[]),/anvil/i)
  assert(!(await arc.send('anvil_nodeInfo',[])).forkConfig?.forkUrl)
  const probe=net.createServer()
  await new Promise((resolve,reject) => {probe.once('error',reject);probe.listen(31557,'127.0.0.1',resolve)})
  await new Promise(resolve=>probe.close(resolve))
  const fixtures=compile('0.8.28',['infra/arc-mainnet/local/BridgeExecutionFixtures.sol','contracts/src/contracts/AcrossMathHelper.sol'])
  const tokenArtifact=compile('0.8.30',['infra/arc-mainnet/local/Fixtures.sol'])['infra/arc-mainnet/local/Fixtures.sol:LocalEURC']
  const artifact=name=>fixtures[`infra/arc-mainnet/local/BridgeExecutionFixtures.sol:${name}`]
  const log=fs.openSync(path.join(out,'bridge-browser-source.log'),'w')
  const child=spawn(path.join(process.env.HOME,'.foundry/bin/anvil'),['--host','127.0.0.1','--port','31557','--chain-id','8453','--silent'],{stdio:['ignore',log,log]})
  fs.closeSync(log)
  const stopped=once(child,'exit')
  const source=new JsonRpcProvider('http://127.0.0.1:31557',8453)
  source.pollingInterval=100
  let browser,page,sourceOrder,sourceReceipt,deposit,fillReceipt
  const requests=[],blocked=new Set(),errors=[]
  const stop=()=>child.kill('SIGTERM')
  process.once('SIGINT',stop);process.once('SIGTERM',stop)
  try {
    for(let i=0;i<100;i++) {try {await source.getBlockNumber();break} catch {await sleep(50)}}
    assert.equal(await source.send('eth_chainId',[]),'0x2105')
    assert.match(await source.send('web3_clientVersion',[]),/anvil/i)
    assert(!(await source.send('anvil_nodeInfo',[])).forkConfig?.forkUrl)
    assert.equal(await source.getBlockNumber(),0)
    const account=(await source.listAccounts())[4]
    same(account,(await arc.listAccounts())[4])
    const signer=source.getSigner(0)
    const put=(address,art)=>source.send('anvil_setCode',[address,'0x'+art['bin-runtime']])
    await put(PROXY,artifact('LocalCreate2Proxy'))
    await put(SPOKE,artifact('LocalSpokePool'))
    await put(SETTLEMENT,artifact('LocalSourceSettlement'))
    await put(RELAYER,artifact('LocalSourceRelayer'))
    await put(BASE_USDC,tokenArtifact)
    await put(MATH,fixtures['contracts/src/contracts/AcrossMathHelper.sol:AcrossMathHelper'])
    const multicall='0xcA11bde05977b3631167028862bE2a173976CA11'
    const multicallCode=await arc.getCode(multicall)
    assert.notEqual(multicallCode,'0x','Arc lab must contain Multicall3')
    await source.send('anvil_setCode',[multicall,multicallCode])
    const salt='0x'+'00'.repeat(32)
    for(const [file,address] of [['weiroll/WeirollVM.initcode',VM],['cowshed/COWShed.initcode','0xa2704cF562AD418Bf0453F4B662ebf6A2489eD88'],['cowshed/COWShedFactory.initcode',FACTORY]]) {
      const init=fs.readFileSync(path.join(root,'contracts/script',file),'utf8').trim()
      same(getCreate2Address(PROXY,salt,keccak256(init)),address)
      await (await signer.sendTransaction({to:PROXY,data:salt+init.slice(2),gasLimit:4000000})).wait()
      assert.notEqual(await source.getCode(address),'0x')
    }
    const wethArtifact=read(path.join(root,'apps/backend/contracts/artifacts/WETH9.json'))
    const wethImpl=await new ContractFactory(wethArtifact.abi,wethArtifact.bytecode,signer).deploy()
    await wethImpl.deployTransaction.wait()
    await source.send('anvil_setCode',[WETH,await source.getCode(wethImpl.address)])
    for(let i=0;i<3;i++) await source.send('anvil_setStorageAt',[WETH,hexZeroPad(hexlify(i),32),await source.getStorageAt(wethImpl.address,i)])
    const weth=new Contract(WETH,wethArtifact.abi,source.getSigner(account))
    await (await weth.deposit({value:'1000000000000000000'})).wait()
    const wethBefore=await weth.balanceOf(account)
    const eurc=new Contract(EURC,tokenArtifact.abi,arc)
    const eurcBefore=await eurc.balanceOf(account)
    const arcSettlement=new Contract(manifest.settlement,
      read(path.join(root,'apps/backend/contracts/artifacts/GPv2Settlement.json')).abi,arc)
    const arcStartBlock=await arc.getBlockNumber()
    // The tested Arc recipient has NO starting funds: later swaps must use the delivered USDC.
    await arc.send('anvil_setBalance',[account,'0x0'])
    const arcToken=new Contract(ARC_USDC,['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)',
      'function allowance(address,address) view returns(uint256)'],arc.getSigner(0))
    assert((await arcToken.balanceOf(account)).isZero())
    const sourceSettlement=new Contract(SETTLEMENT,artifact('LocalSourceSettlement').abi,signer)
    const spoke=new Contract(SPOKE,artifact('LocalSpokePool').abi,signer)
    const baseToken=new Contract(BASE_USDC,tokenArtifact.abi,source)
    const baseTokens=[{chainId:8453,address:BASE_USDC,decimals:6,symbol:'USDC',name:'USD Coin',logoURI:''},
      {chainId:5042,address:ARC_USDC,decimals:6,symbol:'USDC',name:'USD Coin',logoURI:''}]
    const tokenList={name:'Local corridor fixtures',timestamp:new Date().toISOString(),version:{major:1,minor:0,patch:0},
      tokens:[...baseTokens,{chainId:8453,address:WETH,decimals:18,symbol:'WETH',name:'Wrapped Ether'},
        {chainId:5042,address:EURC,decimals:6,symbol:'EURC',name:'EURC'}]}
    let quoteId=100,filledStatusReads=0,pendingStatusReads=0
    async function acceptSourceOrder(order) {
      console.log('Source order submitted; verifying signature and executing signed bridge hook')
      assert(!sourceOrder,'Only one source order is permitted')
      same(order.sellToken,WETH);same(order.buyToken,BASE_USDC)
      assert.equal(order.kind,'sell');assert.equal(order.signingScheme,'eip712')
      assert.equal(order.sellAmount,'50000000000000000')
      assert.equal(keccak256(toUtf8Bytes(order.appData)),order.appDataHash)
      const message={...order,appData:order.appDataHash}
      const domain={name:'Gnosis Protocol',version:'v2',chainId:8453,verifyingContract:SETTLEMENT}
      same(verifyTypedData(domain,orderTypes,message,order.signature),account)
      const hash=_TypedDataEncoder.hash(domain,orderTypes,message)
      const uid=hexConcat([hash,account,hexZeroPad(hexlify(order.validTo),4)])
      const appData=JSON.parse(order.appData)
      assert.equal(appData.metadata.hooks.post.length,1)
      const hook=appData.metadata.hooks.post[0]
      same(hook.target,FACTORY);assert.equal(hook.dappId,'cow-sdk://bridging/providers/across')
      const buyAmount=BigInt(order.sellAmount)*2000n*10n**6n/10n**18n
      assert(buyAmount>=BigInt(order.buyAmount))
      assert((await weth.allowance(account,RELAYER)).gte(order.sellAmount))
      sourceReceipt=await (await sourceSettlement.execute(account,order.receiver,order.sellAmount,buyAmount.toString(),uid,
        [[hook.target,0,hook.callData]],{gasLimit:4000000})).wait()
      deposit=sourceReceipt.logs.filter(log=>log.address.toLowerCase()===SPOKE.toLowerCase())
        .map(log=>spoke.interface.parseLog(log)).find(log=>log.name==='FundsDeposited').args
      same('0x'+deposit.recipient.slice(-40),account)
      same('0x'+deposit.inputToken.slice(-40),BASE_USDC)
      same('0x'+deposit.outputToken.slice(-40),ARC_USDC)
      assert.equal(deposit.destinationChainId.toString(),'5042')
      assert.equal(deposit.inputAmount.toString(),buyAmount.toString())
      assert.equal(deposit.outputAmount.toString(),(buyAmount-buyAmount/1000n).toString())
      assert((await baseToken.balanceOf(SPOKE)).eq(deposit.inputAmount))
      assert((await weth.balanceOf(account)).eq(wethBefore.sub(order.sellAmount)))
      assert((await weth.allowance(account,RELAYER)).isZero(),'Source finite approval fully consumed')
      assert((await baseToken.balanceOf(order.receiver)).isZero())
      assert((await baseToken.allowance(order.receiver,SPOKE)).isZero())
      assert((await arcToken.balanceOf(account)).isZero(),'No arrival before fixture relayer runs')
      const replay=await signer.sendTransaction({to:hook.target,data:hook.callData,gasLimit:1000000})
      await assert.rejects(replay.wait(),error=>error.receipt?.status===0,'Signed bridge hook must not be replayable')
      const replayCall=await (await fetch('http://127.0.0.1:31557',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{from:await signer.getAddress(),to:hook.target,data:hook.callData},'latest']})})).json()
      assert.equal(replayCall.error?.data,keccak256(toUtf8Bytes('NonceAlreadyUsed()')).slice(0,10))
      assert((await spoke.deposits()).eq(1))
      sourceOrder={...order,appData:order.appDataHash,fullAppData:order.appData,uid,owner:account,
        creationDate:new Date().toISOString(),class:'market',status:'fulfilled',invalidated:false,
        executedSellAmount:order.sellAmount,executedSellAmountBeforeFees:order.sellAmount,
        executedBuyAmount:buyAmount.toString(),executedFeeAmount:'0',executedFee:'0',executedSurplusFee:'0',
        availableBalance:'1000000000000000000'}
      return uid
    }
    browser=await chromium.launch({headless:true})
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'})
    await context.routeWebSocket('**/*',socket=>socket.close())
    await context.route('**/*',async route=>{
      try {
      const req=route.request(),url=new URL(req.url())
      const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
      if(url.hostname==='127.0.0.1' && ['5179','8547','8548','8087','31557'].includes(url.port)) return route.continue()
      requests.push({method:req.method(),url:url.origin+url.pathname})
      if((url.hostname==='files.cow.fi' && url.pathname==='/token-lists/CoinGecko.8453.json') ||
          (url.hostname==='swap.ophis.fi' && url.pathname==='/token-lists/ophis.json')) return json(tokenList)
      if(url.hostname==='mainnet.base.org') {
        const response=await fetch('http://127.0.0.1:31557',{method:'POST',headers:{'Content-Type':'application/json'},body:req.postData()})
        return json(await response.json())
      }
      if(url.hostname==='app.across.to') {
        if(url.pathname==='/api/token-list') return json(baseTokens)
        if(url.pathname==='/api/available-routes') return json([{originChainId:8453,originToken:BASE_USDC,originTokenSymbol:'USDC',
          destinationChainId:5042,destinationToken:ARC_USDC,destinationTokenSymbol:'USDC',isNative:false}])
        if(url.pathname==='/api/suggested-fees') {
          assert.equal(url.searchParams.get('originChainId'),'8453');assert.equal(url.searchParams.get('destinationChainId'),'5042')
          const amount=BigInt(url.searchParams.get('amount')),timestamp=(await source.getBlock('latest')).timestamp
          const fee={pct:'1000000000000000',total:(amount/1000n).toString()},zeroFee={pct:'0',total:'0'}
          return json({spokePoolAddress:SPOKE,timestamp:String(timestamp),fillDeadline:String(timestamp+3600),
            destinationSpokePoolAddress:'0x9b4A302A548c7e313c2b74C461db7b84d3074A84',
            quoteBlock:String(await source.getBlockNumber()),exclusiveRelayer:ZERO,exclusivityDeadline:0,
            limits:{minDeposit:'1',maxDeposit:'1000000000000',maxDepositInstant:'1000000000000',
              maxDepositShortDelay:'1000000000000',recommendedDepositInstant:'1000000000000'},
            totalRelayFee:fee,relayerCapitalFee:fee,relayerGasFee:zeroFee,lpFee:zeroFee,
            outputAmount:(amount-amount/1000n).toString(),isAmountTooLow:false,estimatedFillTimeSec:5})
        }
        if(url.pathname==='/api/deposit/status') {
          assert(sourceReceipt && deposit);assert.equal(url.searchParams.get('depositId'),deposit.depositId.toString())
          if(fillReceipt) filledStatusReads++;else pendingStatusReads++
          return json({status:fillReceipt?'filled':'slowFillRequested',depositTxHash:sourceReceipt.transactionHash,fillTx:fillReceipt?.transactionHash})
        }
      }
      if(url.hostname==='api.cow.fi' && url.pathname.startsWith('/base/')) {
        const endpoint=url.pathname.slice('/base'.length)
        if(endpoint==='/api/v1/quote') {
          const q=req.postDataJSON(),amount=BigInt(q.sellAmountBeforeFee || q.sellAmountAfterFee)
          if(q.sellToken.toLowerCase()!==WETH.toLowerCase() || q.buyToken.toLowerCase()!==BASE_USDC.toLowerCase()) {
            console.log('Source fixture rejects unsupported pair',q.sellToken,q.buyToken)
            return json({errorType:'NoLiquidity',description:'Local source fixture only supports WETH/USDC'},400)
          }
          return json({quote:{sellToken:WETH,buyToken:BASE_USDC,receiver:q.receiver || ZERO,
            sellAmount:amount.toString(),buyAmount:(amount*2000n*10n**6n/10n**18n).toString(),
            validTo:q.validTo || Math.floor(Date.now()/1000)+1800,appData:q.appDataHash || '0x'+'00'.repeat(32),
            feeAmount:'0',gasAmount:'300000',gasPrice:'1000000',sellTokenPrice:'1',kind:'sell',partiallyFillable:false,
            sellTokenBalance:'erc20',buyTokenBalance:'erc20',signingScheme:'eip712'},from:q.from,
            expiration:new Date(Date.now()+600000).toISOString(),id:quoteId++,verified:false})
        }
        if(endpoint==='/api/v1/orders' && req.method()==='POST') {
          try {return json(await acceptSourceOrder(req.postDataJSON()),201)}
          catch(error) {errors.push(String(error));console.error(String(error));return json({errorType:'LocalFixtureError',description:String(error)},400)}
        }
        if(endpoint.startsWith('/api/v1/orders/')) {
          if(endpoint.endsWith('/status')) return json({type:'traded'})
          return sourceOrder?json(sourceOrder):json({errorType:'NotFound'},404)
        }
        if(endpoint.startsWith('/api/v2/trades') || endpoint.startsWith('/api/v1/trades')) return json(sourceOrder?[{
          blockNumber:sourceReceipt.blockNumber,logIndex:0,orderUid:sourceOrder.uid,owner:account,
          sellToken:WETH,buyToken:BASE_USDC,sellAmount:sourceOrder.sellAmount,buyAmount:sourceOrder.executedBuyAmount,
          sellAmountBeforeFees:sourceOrder.sellAmount,txHash:sourceReceipt.transactionHash}]:[])
        if(endpoint.includes('/native_price')) return json({price:endpoint.toLowerCase().includes(WETH.toLowerCase())?'1':'500000000000'})
        if(endpoint.includes('/orders')) return json(sourceOrder?[sourceOrder]:[])
        if(endpoint.includes('/app_data/')) return json(sourceOrder?{fullAppData:sourceOrder.fullAppData}:{})
      }
      blocked.add(url.origin+url.pathname)
      return route.abort()
      } catch(error) {
        errors.push(String(error));console.error('Local request handler:',String(error))
        await route.abort().catch(()=>{})
      }
    })
    await context.addInitScript(({account,arcSettlement,arcRelayer,weth,arcUsdc,sourceSettlement,sourceRelayer})=>{
      const listeners={};let chainId=8453
      window.corridorSignatures=[];window.corridorSwitches=[]
      const provider={isMetaMask:true,selectedAddress:account,chainId:'0x2105',networkVersion:'8453',
        isConnected:()=>true,_metamask:{isUnlocked:async()=>true},
        on:(name,fn)=>{(listeners[name]??=[]).push(fn);return provider},
        removeListener:(name,fn)=>{listeners[name]=(listeners[name]||[]).filter(x=>x!==fn);return provider},
        request:async({method,params=[]})=>{
          if(['eth_accounts','eth_requestAccounts'].includes(method))return [account]
          if(method==='eth_chainId')return '0x'+chainId.toString(16)
          if(method==='net_version')return String(chainId)
          if(['wallet_requestPermissions','wallet_getPermissions'].includes(method))return [{parentCapability:'eth_accounts'}]
          if(method==='wallet_switchEthereumChain') {
            const next=Number(params[0].chainId);if(![8453,5042].includes(next))throw Error('Only local fixture chains')
            chainId=next;provider.chainId=params[0].chainId;provider.networkVersion=String(next)
            window.corridorSwitches.push(next);for(const fn of listeners.chainChanged||[])fn(provider.chainId)
            return null
          }
          if(method.startsWith('eth_signTypedData')) {
            const data=typeof params[1]==='string'?JSON.parse(params[1]):params[1]
            if(Number(data.domain.chainId)!==chainId)throw Error('Signing chain mismatch')
            if(data.primaryType==='Order' && data.domain.verifyingContract.toLowerCase()!==
              (chainId===5042?arcSettlement:sourceSettlement).toLowerCase())throw Error('Signing settlement mismatch')
            if(data.primaryType==='Permit' && (chainId!==5042 || data.domain.verifyingContract.toLowerCase()!==arcUsdc.toLowerCase() ||
              data.message.spender.toLowerCase()!==arcRelayer.toLowerCase() || BigInt(data.message.value)!==10000000n))throw Error('Permit mismatch')
            if(!['Order','Permit'].includes(data.primaryType) && data.domain.name!=='COWShed')throw Error('Unexpected signature')
            window.corridorSignatures.push({chainId,type:data.primaryType,domain:data.domain.name})
          }
          if(method==='eth_sendTransaction') {
            const tx=params[0],token=chainId===5042?arcUsdc:weth,spender=chainId===5042?arcRelayer:sourceRelayer
            if(tx.from.toLowerCase()!==account.toLowerCase() || tx.to.toLowerCase()!==token.toLowerCase() ||
              !tx.data.startsWith('0x095ea7b3') || tx.data.slice(34,74).toLowerCase()!==spender.slice(2).toLowerCase() ||
              BigInt('0x'+tx.data.slice(74))!==(chainId===5042?10000000n:50000000000000000n) ||
              (tx.value && BigInt(tx.value)!==0n))throw Error('Only local finite token approval permitted')
          }
          const response=await fetch(chainId===5042?'http://127.0.0.1:8547':'http://127.0.0.1:31557',{
            method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})
          const body=await response.json();if(body.error)throw Object.assign(new Error(body.error.message),body.error);return body.result
        }}
      provider.enable=()=>provider.request({method:'eth_requestAccounts'})
      provider.sendAsync=(payload,callback)=>provider.request(payload).then(result=>callback(null,{jsonrpc:'2.0',id:payload.id,result}),callback)
      provider.send=(method,params)=>typeof method==='string'?provider.request({method,params}):provider.sendAsync(method,params)
      window.ethereum=provider
      const announce=()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{provider,info:{
        uuid:'350670db-19fa-4704-a166-e52e178b59d2',name:'Local Corridor Wallet',rdns:'io.metamask',
        icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'}}}))
      window.addEventListener('eip6963:requestProvider',announce);announce()
    },{account,arcSettlement:manifest.settlement,arcRelayer:manifest.vaultRelayer,weth:WETH,arcUsdc:ARC_USDC,
      sourceSettlement:SETTLEMENT,sourceRelayer:RELAYER})
    page=await context.newPage()
    page.on('console',message=>{
      if(/Could not make a multicall|provider chain mismatch|TRADE STATE|switch network|switching error/i.test(message.text())) console.log(message.text().slice(0,1800))
    })
    console.log('Local chains and committed bridge bytecode ready; opening frontend')
    console.log('Source WETH balance',String(await weth.balanceOf(account)),'multicall bytes',(await source.getCode('0xcA11bde05977b3631167028862bE2a173976CA11')).length)
    page.on('pageerror',error=>errors.push(String(error)))
    await page.goto(`http://127.0.0.1:5179/#/8453/swap/${WETH}/${ARC_USDC}?targetChainId=5042&sellAmount=0.05`)
    await page.getByRole('button',{name:'Connect Wallet',exact:true}).waitFor({timeout:60000})
    await page.getByRole('button',{name:'Connect Wallet',exact:true}).click()
    await page.getByRole('button',{name:/Local Corridor Wallet/}).click()
    console.log('Source wallet connected; waiting for bridge quote')
    await page.getByRole('button',{name:/Approve.*Swap/}).waitFor({timeout:45000})
    const options=page.locator('summary').filter({hasText:'Approval options'})
    if(await options.isVisible())await options.click()
    await page.getByRole('button',{name:/^Partial approval/}).click()
    await page.getByRole('button',{name:/Approve.*Swap/}).click()
    console.log('Source finite approval requested; awaiting bridge confirmation')
    const [sourceResponse]=await Promise.all([
      page.waitForResponse(r=>r.url().includes('api.cow.fi/base/api/v1/orders') && r.request().method()==='POST',{timeout:45000}),
      page.getByRole('button',{name:/Confirm.*(Swap|Bridge)/i}).click({timeout:45000}),
    ])
    assert.equal(sourceResponse.status(),201,await sourceResponse.text())
    console.log('Source order and bridge hook executed; awaiting pending bridge UI')
    // Remain on Base while the real SDK decodes the receipt and polls the mocked relayer.
    for(let i=0;i<90 && !pendingStatusReads;i++)await sleep(1000)
    assert(sourceOrder && pendingStatusReads>0,`Bridge did not enter pending: ${errors}`)
    assert((await arcToken.balanceOf(account)).isZero())
    await page.getByText('in progress',{exact:true}).last().waitFor({timeout:30000})
    assert.equal(await page.getByText('Bridging completed!',{exact:true}).count(),0)
    await page.screenshot({path:path.join(out,'bridge-browser-pending.png'),fullPage:true})
    fillReceipt=await (await arcToken.transfer(account,deposit.outputAmount)).wait()
    assert((await arcToken.balanceOf(account)).eq(deposit.outputAmount))
    for(let i=0;i<30 && !filledStatusReads;i++)await sleep(1000)
    assert(filledStatusReads>0)
    await page.getByText('Bridging completed!',{exact:true}).waitFor({timeout:30000})
    await page.screenshot({path:path.join(out,'bridge-browser-received.png'),fullPage:true})
    // Use the SAME wallet/session and the newly delivered balance on Arc.
    await page.getByRole('button',{name:'Close',exact:true}).click()
    await page.getByText('Base',{exact:true}).first().click()
    await page.getByRole('button',{name:'Arc (local)',exact:true}).click()
    await page.waitForFunction(()=>window.ethereum.chainId==='0x13b2' && location.hash.startsWith('#/5042/'),{},{timeout:30000})
    await page.evaluate(({usdc,eurc})=>{location.hash=`/5042/swap/${usdc}/${eurc}`},{usdc:ARC_USDC,eurc:EURC})
    console.log('Bridge received; opening Arc swap with delivered USDC')
    await page.getByPlaceholder('0',{exact:true}).first().fill('10')
    await page.getByRole('button',{name:/Approve and Swap/}).waitFor({timeout:45000})
    // The finite-approval preference selected on Base persists in this session.
    await page.getByRole('button',{name:/Approve and Swap/}).click()
    const [response]=await Promise.all([
      page.waitForResponse(r=>r.url()==='http://127.0.0.1:8087/api/v1/orders' && r.request().method()==='POST',{timeout:45000}),
      page.getByRole('button',{name:'Confirm Swap',exact:true}).click(),
    ])
    assert.equal(response.status(),201,await response.text())
    console.log('Arc order submitted; awaiting automatic solver settlement')
    const arcUid=await response.json(),arcOrder=response.request().postDataJSON()
    same(arcOrder.sellToken,ARC_USDC);same(arcOrder.buyToken,EURC);same(arcOrder.receiver,account)
    assert.equal(arcOrder.sellAmount,'10000000')
    let status
    for(let i=0;i<120;i++) {status=(await (await fetch(`http://127.0.0.1:8087/api/v1/orders/${arcUid}`)).json()).status;if(status==='fulfilled')break;await sleep(1000)}
    assert.equal(status,'fulfilled')
    const eurcReceived=(await eurc.balanceOf(account)).sub(eurcBefore)
    assert(eurcReceived.gte(arcOrder.buyAmount))
    assert((await arcSettlement.filledAmount(arcUid)).eq(arcOrder.sellAmount))
    const trades=await arcSettlement.queryFilter(arcSettlement.filters.Trade(account),arcStartBlock)
    const trade=trades.find(event=>event.args.orderUid.toLowerCase()===arcUid.toLowerCase())
    assert(trade,'Exact Arc order must have a Trade event')
    const arcTx=await arc.getTransaction(trade.transactionHash)
    same(arcTx.from,manifest.solver);same(arcTx.to,manifest.settlement)
    assert(arcTx.data.startsWith('0x13d79a0b') && arcTx.value.isZero())
    assert((await arcToken.allowance(account,manifest.vaultRelayer)).isZero())
    const remaining=await arcToken.balanceOf(account)
    // Permit/order signatures are gasless for this wallet; the solver pays settlement gas.
    assert(remaining.eq(deposit.outputAmount.sub(arcOrder.sellAmount)))
    await page.getByText(/Transaction completed|Swap completed|Swapped/).first().waitFor({timeout:30000})
    const signatures=await page.evaluate(()=>window.corridorSignatures)
    assert(signatures.some(s=>s.chainId===8453 && s.domain==='COWShed'))
    assert(signatures.some(s=>s.chainId===8453 && s.type==='Order'))
    assert(signatures.some(s=>s.chainId===5042 && s.type==='Permit'))
    assert(signatures.some(s=>s.chainId===5042 && s.type==='Order'))
    assert.deepEqual(errors,[],'No browser runtime or fixture execution errors')
    await page.screenshot({path:path.join(out,'bridge-browser-arc-swap.png'),fullPage:true})
    fs.writeFileSync(path.join(out,'bridge-browser-result.json'),JSON.stringify({localOnly:true,
      sourceFixture:true,relayerFixture:true,realArcBackend:true,sourceOrderUid:sourceOrder.uid,
      sourceTransaction:sourceReceipt.transactionHash,depositId:deposit.depositId.toString(),
      deposited:deposit.inputAmount.toString(),arrived:deposit.outputAmount.toString(),fillTransaction:fillReceipt.transactionHash,
      pendingStatusReads,filledStatusReads,arcOrderUid:arcUid,arcStatus:status,arcUsdcRemaining:remaining.toString(),
      arcSettlementTransaction:arcTx.hash,eurcReceived:eurcReceived.toString(),
      signatures,externalRpcRequests:0,liveBridgeFill:false},null,2)+'\n')
    console.log('PASS: frontend source swap + signed CoW Shed/Weiroll deposit + pending/received bridge UI + fixture arrival + automatic Arc swap using arrived USDC; zero public RPC')
  } catch(error) {
    if(page) {console.error((await page.locator('body').innerText()).slice(0,9000));await page.screenshot({path:path.join(out,'bridge-browser-error.png'),fullPage:true}).catch(()=>{})}
    console.error(errors);throw error
  } finally {
    fs.writeFileSync(path.join(out,'bridge-browser-requests.json'),JSON.stringify({requests,blocked:[...blocked],errors},null,2))
    await browser?.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)
    child.kill('SIGTERM');if(child.exitCode===null)await stopped
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
