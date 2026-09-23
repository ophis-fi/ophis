// Real frontend/orderbook, disposable Arc Anvil only. Every external browser request is blocked.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../../..')
const frontend = path.join(root, 'apps/frontend')
const dependency = createRequire(path.join(frontend, 'apps/cowswap-frontend/package.json'))
const { JsonRpcProvider } = dependency('@ethersproject/providers')
const { Contract } = dependency('@ethersproject/contracts')
const { Interface } = dependency('@ethersproject/abi')
// Reuse the already-installed browser tooling; never install/download during this check.
const store = path.join(frontend, 'node_modules/.pnpm')
const playwright = fs.readdirSync(store).find(name => name.startsWith('playwright@'))
assert(playwright, 'Install the repository browser tooling first')
const { chromium } = require(path.join(store, playwright, 'node_modules/playwright'))
const output = path.join(__dirname, 'generated')
const manifest = require('./generated/deployment.json')
const artifacts = require('./generated/contracts.json').contracts
const abi = name => Object.entries(artifacts).find(([key]) => key.endsWith(`:${name}`))[1].abi
const USDC = '0x3600000000000000000000000000000000000000'
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
const rpc = new JsonRpcProvider('http://127.0.0.1:8547')
rpc.pollingInterval = 100

async function main() {
  assert(manifest.localOnly && manifest.rpc === 'http://127.0.0.1:8547' && manifest.chainId === 5042)
  assert.equal(await rpc.send('eth_chainId', []), '0x13b2')
  assert.match(await rpc.send('web3_clientVersion', []), /anvil/i)
  assert(!(await rpc.send('anvil_nodeInfo', [])).forkConfig?.forkUrl, 'No forks')
  const account = (await rpc.listAccounts())[4]
  const token = new Contract(USDC, ['function approve(address,uint256) returns(bool)',
    'function allowance(address,address) view returns(uint256)'], rpc.getSigner(account))
  await (await token.approve(manifest.vaultRelayer, 0)).wait()
  const eurc = new Contract(EURC, abi('LocalEURC'), rpc)
  const before = await eurc.balanceOf(account)
  const settlement = new Contract(manifest.settlement, abi('GPv2Settlement'), rpc)
  const startBlock = await rpc.getBlockNumber()
  const rpcBefore = await (await fetch('http://127.0.0.1:8548/counts')).json()
  const started = Date.now()
  const browser = await chromium.launch({headless:true})
  let page
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000}})
    const blocked = new Set()
    await context.route('**/*', route => {
      const host = new URL(route.request().url()).hostname
      if (host === '127.0.0.1') return route.continue()
      blocked.add(host)
      return route.abort()
    })
    await context.addInitScript(({account, settlement, relayer, usdc}) => {
      const listeners = {}
      window.arcTestSignatures = []
      window.arcTestRejections = []
      const provider = {
        isMetaMask:true, chainId:'0x13b2', networkVersion:'5042', selectedAddress:account,
        isConnected:() => true, _metamask:{isUnlocked:async() => true},
        on:(name, fn) => { (listeners[name] ??= []).push(fn); return provider },
        removeListener:(name, fn) => { listeners[name] = (listeners[name] || []).filter(x => x !== fn); return provider },
        request:async({method, params=[]}) => {
          if (['eth_accounts','eth_requestAccounts'].includes(method)) return [account]
          if (method === 'eth_chainId') return '0x13b2'
          if (method === 'net_version') return '5042'
          if (['wallet_requestPermissions','wallet_getPermissions'].includes(method)) return [{parentCapability:'eth_accounts'}]
          if (method === 'wallet_switchEthereumChain') {
            if (params[0].chainId !== '0x13b2') throw Error('Local Arc only')
            return null
          }
          if (method.startsWith('eth_signTypedData')) {
            const data = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
            if (Number(data.domain.chainId) !== 5042) throw Error('Wrong signing chain')
            const expected = data.primaryType === 'Permit' ? usdc : settlement
            if (data.domain.verifyingContract.toLowerCase() !== expected.toLowerCase()) throw Error('Wrong signing contract')
            if (data.primaryType === 'Permit' && (BigInt(data.message.value) !== 10000000n ||
                data.message.spender.toLowerCase() !== relayer.toLowerCase())) throw Error('Wrong permit limit or spender')
            if (data.primaryType === 'Permit' && window.arcTestRejections.length === 0) {
              window.arcTestRejections.push('Permit')
              throw Object.assign(new Error('User rejected test permit'), {code:4001})
            }
            window.arcTestSignatures.push(data.primaryType)
          }
          if (method === 'eth_sendTransaction' && (params[0].from.toLowerCase() !== account.toLowerCase() ||
              params[0].to.toLowerCase() !== usdc.toLowerCase() || !params[0].data.startsWith('0x095ea7b3'))) {
            throw Error('Only local token approvals are allowed from the browser')
          }
          // The existing UI falls back to an approval transaction after a rejected permit.
          // Reject that prompt too, then prove a fresh click can complete with a permit.
          if (method === 'eth_sendTransaction' && window.arcTestRejections.length === 1) {
            window.arcTestRejections.push('Approval')
            throw Object.assign(new Error('User rejected test approval'), {code:4001})
          }
          const response = await fetch('http://127.0.0.1:8547', {method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({jsonrpc:'2.0', id:1, method, params})})
          const body = await response.json()
          if (body.error) throw Object.assign(new Error(body.error.message), body.error)
          return body.result
        },
      }
      provider.enable = () => provider.request({method:'eth_requestAccounts'})
      provider.sendAsync = (payload, callback) => provider.request(payload)
        .then(result => callback(null, {jsonrpc:'2.0', id:payload.id, result}), callback)
      provider.send = (method, params) => typeof method === 'string'
        ? provider.request({method, params}) : provider.sendAsync(method, params)
      window.ethereum = provider
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail:{provider,
        info:{uuid:'350670db-19fa-4704-a166-e52e178b59d2', name:'Local Arc Wallet', rdns:'io.metamask',
          icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'}}}))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    }, {account, settlement:manifest.settlement, relayer:manifest.vaultRelayer, usdc:USDC})
    page = await context.newPage()
    await page.goto('http://127.0.0.1:5179/#/5042/swap/USDC/EURC')
    await page.waitForLoadState('networkidle', {timeout:30000}).catch(() => {})
    await page.getByRole('button', {name:'Connect Wallet', exact:true}).waitFor({timeout:60000})
    await page.getByPlaceholder('0', {exact:true}).first().fill('10')
    await page.getByRole('button', {name:'Connect Wallet', exact:true}).click()
    await page.getByRole('button', {name:/Local Arc Wallet/}).click()
    await page.getByRole('button', {name:/Approve and Swap/}).waitFor()
    const options = page.locator('summary').filter({hasText:'Approval options'})
    if (await options.isVisible()) await options.click()
    await page.getByRole('button', {name:/^Partial approval/}).click()
    await page.getByRole('button', {name:/Approve and Swap/}).click()
    await page.getByText('User rejected approval transaction', {exact:true}).waitFor()
    assert.deepEqual(await page.evaluate(() => window.arcTestRejections), ['Permit','Approval'])
    assert((await token.allowance(account,manifest.vaultRelayer)).isZero(), 'Rejected prompts must not approve funds')
    console.log('PASS: rejected permit and fallback approval leave allowance unchanged')
    await page.getByRole('button', {name:/Dismiss|Close|Try again/i}).last().click()
    await page.getByRole('button', {name:/Approve and Swap/}).click()
    const submitted = page.waitForResponse(response =>
      response.url() === 'http://127.0.0.1:8087/api/v1/orders' && response.request().method() === 'POST', {timeout:45000})
    await page.getByRole('button', {name:'Confirm Swap', exact:true}).click()
    const response = await submitted
    assert.equal(response.status(), 201, await response.text())
    const uid = await response.json()
    const order = response.request().postDataJSON()
    assert.equal(order.sellAmount, '10000000')
    assert.equal(order.signingScheme, 'eip712')
    const appData = JSON.parse(order.appData)
    const hooks = appData.metadata?.hooks?.pre || []
    assert.equal(hooks.length, 1, 'Exactly one finite permit pre-hook is required')
    const permit = new Interface(['function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)'])
    for (const hook of hooks) {
      assert.equal(hook.target.toLowerCase(), USDC.toLowerCase())
      const data = permit.decodeFunctionData('permit', hook.callData)
      assert.equal(data.owner.toLowerCase(), account.toLowerCase())
      assert.equal(data.spender.toLowerCase(), manifest.vaultRelayer.toLowerCase())
      assert(data.value.eq(order.sellAmount), 'Finite approval must survive into submitted appData')
    }
    if (!manifest.automaticSettlement) {
      // Legacy manual check; automatic mode must reach fulfillment through the driver.
      const router = new Contract(manifest.venues['uniswap-v3'].router, abi('LocalV3Venue'), rpc)
      const trade = [0,1,order.receiver,order.sellAmount,order.buyAmount,order.validTo,order.appDataHash,
        order.feeAmount,0,order.sellAmount,order.signature]
      const calls = [
        [USDC,0,token.interface.encodeFunctionData('approve',[router.address,order.sellAmount])],
        [router.address,0,router.interface.encodeFunctionData('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
          [[USDC,EURC,500,settlement.address,order.sellAmount,order.sellAmount,0]])],
      ]
      await (await settlement.connect(rpc.getSigner(manifest.solver)).settle([USDC,EURC],[1,1],[trade],
        [hooks.map(h => [h.target,0,h.callData]),calls,[]])).wait()
      await rpc.send('anvil_mine',['0x3'])
    }
    let status
    for (let attempt=0; attempt<120; attempt++) {
      const result = await fetch(`http://127.0.0.1:8087/api/v1/orders/${uid}`)
      status = (await result.json()).status
      if (status === 'fulfilled') break
      await new Promise(resolve => setTimeout(resolve,1000))
    }
    assert.equal(status,'fulfilled')
    const received = (await eurc.balanceOf(account)).sub(before)
    assert(received.gte(order.buyAmount), 'Signed minimum output must be delivered')
    assert((await settlement.filledAmount(uid)).eq(order.sellAmount))
    assert((await token.allowance(account,manifest.vaultRelayer)).isZero(), 'No residual finite allowance')
    await page.getByText(/Transaction completed|Swap completed|Swapped/).first().waitFor({timeout:30000})
    assert(!(await page.locator('body').innerText()).includes('Something went wrong'))
    const signatures = await page.evaluate(() => window.arcTestSignatures)
    assert(signatures.includes('Permit'), 'Successful retry must sign a permit')
    assert(signatures.includes('Order'))
    const trades = await settlement.queryFilter(settlement.filters.Trade(account), startBlock)
    const tradeEvent = trades.find(event => event.args.orderUid.toLowerCase() === uid.toLowerCase())
    assert(tradeEvent, 'The submitted order must have an onchain Trade event')
    const tx = await rpc.getTransaction(tradeEvent.transactionHash)
    assert.equal(tx.from.toLowerCase(), manifest.solver.toLowerCase())
    assert.equal(tx.to.toLowerCase(), settlement.address.toLowerCase())
    assert(tx.data.startsWith('0x13d79a0b') && tx.value.isZero())
    const rpcAfter = await (await fetch('http://127.0.0.1:8548/counts')).json()
    const backendRpc = Object.fromEntries(Object.entries(rpcAfter).map(([method,count]) =>
      [method,count - (rpcBefore[method] || 0)]).filter(([,count]) => count > 0))
    if (manifest.automaticSettlement) assert(backendRpc.eth_sendRawTransaction >= 1)
    await page.screenshot({path:path.join(output,'browser-completed.png'),fullPage:true})
    fs.writeFileSync(path.join(output,'browser-result.json'),JSON.stringify({uid,status,signatures,
      rejectionRecovery: true,
      settlementTx:tx.hash, elapsedSeconds:(Date.now()-started)/1000, backendRpc,
      automaticSettlement:manifest.automaticSettlement === true, eurcReceived:received.toString(), externalHostsBlocked:[...blocked]},null,2)+'\n')
    console.log(`PASS: local browser finite approval, Arc EIP-712 signature, order submission, ${manifest.automaticSettlement ? 'automatic' : 'manual'} settlement and completed UI`)
  } catch (error) {
    if (page) {
      console.error((await page.locator('body').innerText()).slice(0,5000))
      await page.screenshot({path:path.join(output,'browser-error.png'),fullPage:true}).catch(() => {})
    }
    throw error
  } finally {
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
