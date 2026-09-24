// Local Arc Anvil only. No external keys, remote URL options, or broadcast fallback.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../../..')
const dependency = createRequire(path.join(root, 'apps/frontend/apps/cowswap-frontend/package.json'))
const { JsonRpcProvider } = dependency('@ethersproject/providers')
const { Contract, ContractFactory } = dependency('@ethersproject/contracts')
const { _TypedDataEncoder } = dependency('@ethersproject/hash')
const { hexConcat, hexZeroPad, hexlify } = dependency('@ethersproject/bytes')
const output = path.join(__dirname, 'generated')
const USDC = '0x3600000000000000000000000000000000000000'
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
const ROUTER = '0xA4072583658Fae592A3506A42431cb6316a8d40b'
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const artifacts = read(path.join(output, 'contracts.json')).contracts
const artifact = (name) => {
  const entry = Object.entries(artifacts).find(([key]) => key.endsWith(`:${name}`))
  assert(entry, `Build ${name} first`)
  return { abi: entry[1].abi, bytecode: `0x${entry[1].bin}`, runtime: `0x${entry[1]['bin-runtime']}` }
}

async function main() {
  assert(process.argv.slice(2).every(arg => arg === '--automatic-settlement'))
  const automatic = process.argv.includes('--automatic-settlement')
  const rpc = new JsonRpcProvider('http://127.0.0.1:8547')
  rpc.pollingInterval = 100
  assert.equal(await rpc.send('eth_chainId', []), '0x13b2')
  assert.match(await rpc.send('web3_clientVersion', []), /anvil/i)
  // anvil_nodeInfo is unavailable on production endpoints; also refuse a fork.
  const info = await rpc.send('anvil_nodeInfo', [])
  assert(!info.forkConfig?.forkUrl, 'Forks are not allowed')
  const [manager, trader, solver] = await rpc.listAccounts()
  assert(manager && trader && solver)
  const signer = rpc.getSigner(manager)
  async function deploy(data, args = []) {
    const contract = await new ContractFactory(data.abi, data.bytecode, signer).deploy(...args)
    await contract.deployTransaction.wait()
    return contract
  }
  const auth = await deploy(artifact('GPv2AllowListAuthentication'))
  await (await auth.initializeManager(manager)).wait()
  await (await auth.addSolver(solver)).wait()
  const vault = await deploy(artifact('DisabledVault'))
  const settlement = await deploy(artifact('GPv2Settlement'), [auth.address, vault.address])
  const helpers = {}
  for (const name of ['Balances', 'Signatures', 'HooksTrampoline']) {
    const data = read(path.join(root, 'apps/backend/contracts/artifacts', `${name}.json`))
    helpers[name] = (await deploy(data, name === 'HooksTrampoline' ? [settlement.address] : [])).address
  }
  // Install explicitly labelled fixture liquidity at the configured token/router addresses.
  await rpc.send('anvil_setCode', [EURC, artifact('LocalEURC').runtime])
  await rpc.send('anvil_setCode', [ROUTER, artifact('LocalRouter').runtime])
  await rpc.send('anvil_setBalance', [ROUTER, '0x3635c9adc5dea00000'])
  const kyberRouter = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'
  await rpc.send('anvil_setCode', [kyberRouter, artifact('LocalRouter').runtime])
  await rpc.send('anvil_setBalance', [kyberRouter, '0x3635c9adc5dea00000'])
  const venues = {
    'uniswap-v3': { factory: '0xf0db7b58379503491d857dB50AC9ece64c653918', quoter: '0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468', router: '0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77' },
    synthra: { factory: '0x6307fc239C7964942c1BfFE51930E55606619c74', quoter: '0x9c179A7335B3fc841F59Aa6a62daf6d5c61b65D7', router: '0xa50eDe66a573eE5bB37E28AF5789B76aE5FEb828' },
    achswap: { factory: '0xaE54BF4C8078BaAAf7e17f8e01659Ea470a989FC', quoter: '0x659Da32F3F10566bDB6B55Ad84c182f1D00Ba058', router: '0xEA0129203FBB99ebEea3f78B2d05b924f17FB556' },
  }
  for (const venue of Object.values(venues)) {
    for (const address of Object.values(venue)) {
      await rpc.send('anvil_setCode', [address, artifact('LocalV3Venue').runtime])
      await (await new Contract(address, artifact('LocalV3Venue').abi, signer).setRate(10000)).wait()
    }
    await rpc.send('anvil_setBalance', [venue.router, '0x3635c9adc5dea00000'])
  }
  const usdc = new Contract(USDC, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], rpc.getSigner(trader))
  // Exercise the read-only probe against fixtures before any live read is used.
  const { defaultAbiCoder } = dependency('@ethersproject/abi')
  const probe = '0x0000000000000000000000000000000000012345'
  for (const [name, venue] of Object.entries(venues)) {
    const data = defaultAbiCoder.encode(['address','uint24','bool','uint256','uint256'],
      [venue.router,500,name === 'achswap',1000000,1000000])
    const result = await rpc.send('eth_call', [{to:probe,data}, 'latest',
      {[probe]:{code:artifact('ReadOnlyV3Probe').runtime,balance:'0x3635c9adc5dea00000'}}])
    assert.deepEqual(defaultAbiCoder.decode(['uint256','uint256'], result).map(String), ['1000000','1000000'])
    const tooHigh = defaultAbiCoder.encode(['address','uint24','bool','uint256','uint256'],
      [venue.router,500,name === 'achswap',1000000,1000001])
    await assert.rejects(rpc.send('eth_call', [{to:probe,data:tooHigh}, 'latest',
      {[probe]:{code:artifact('ReadOnlyV3Probe').runtime,balance:'0x3635c9adc5dea00000'}}]))
  }
  console.log('PASS: read-only router probe measures both token deltas and rejects insufficient output')
  const eurc = new Contract(EURC, artifact('LocalEURC').abi, rpc)
  const native = await rpc.getBalance(trader)
  assert((await usdc.balanceOf(trader)).eq(native.div('1000000000000')), 'Arc native/token units')
  const relayer = await settlement.vaultRelayer()
  await (await usdc.approve(relayer, 400_000_000)).wait()
  const validTo = (await rpc.getBlock('latest')).timestamp + 3600
  const order = { sellToken: USDC, buyToken: EURC, receiver: trader, sellAmount: '100000000', buyAmount: '99000000',
    validTo, appData: hexZeroPad('0x00', 32), feeAmount: '0', kind: 'sell', partiallyFillable: false,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' }
  const fields = [['sellToken','address'],['buyToken','address'],['receiver','address'],['sellAmount','uint256'],
    ['buyAmount','uint256'],['validTo','uint32'],['appData','bytes32'],['feeAmount','uint256'],['kind','string'],
    ['partiallyFillable','bool'],['sellTokenBalance','string'],['buyTokenBalance','string']].map(([name,type]) => ({name,type}))
  const hash = _TypedDataEncoder.hash({name:'Gnosis Protocol',version:'v2',chainId:5042,verifyingContract:settlement.address}, {Order:fields}, order)
  const uid = hexConcat([hash, trader, hexZeroPad(hexlify(validTo), 4)])
  await (await settlement.connect(rpc.getSigner(trader)).setPreSignature(uid, true)).wait()
  const router = new Contract(venues['uniswap-v3'].router, artifact('LocalV3Venue').abi, rpc)
  const trade = [0, 1, trader, order.sellAmount, order.buyAmount, validTo, order.appData, 0, 96, order.sellAmount, trader]
  const calls = [
    [USDC, 0, usdc.interface.encodeFunctionData('approve', [router.address, order.sellAmount])],
    [router.address, 0, router.interface.encodeFunctionData('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))', [[USDC, EURC, 500, settlement.address, order.sellAmount, order.sellAmount, 0]])],
  ]
  const before = await eurc.balanceOf(trader)
  await (await settlement.connect(rpc.getSigner(solver)).settle([USDC, EURC], [1, 1], [trade], [[], calls, []])).wait()
  assert((await eurc.balanceOf(trader)).sub(before).eq(order.sellAmount), 'Settlement delivered EURC')
  assert((await settlement.filledAmount(uid)).eq(order.sellAmount))
  await assert.rejects(settlement.connect(rpc.getSigner(trader)).callStatic.settle([], [], [], [[], [], []]))
  const keyFile = path.join(output, 'anvil-solver.key')
  fs.rmSync(keyFile, {force:true})
  if (automatic) {
    const { Wallet } = dependency('@ethersproject/wallet')
    const wallet = Wallet.fromMnemonic('test test test test test test test test test test test junk', "m/44'/60'/0'/0/2")
    assert.equal(wallet.address.toLowerCase(), solver.toLowerCase())
    fs.writeFileSync(keyFile, wallet.privateKey+'\n', {mode:0o600, flag:'wx'})
    await rpc.send('anvil_setIntervalMining', [1])
  }
  const manifest = {localOnly:true, automaticSettlement:automatic, chainId:5042, rpc:'http://127.0.0.1:8547', settlement:settlement.address,
    authenticator:auth.address, vaultRelayer:relayer, vault:vault.address, manager, trader, solver, venues, ...helpers,
    deploymentBlock:(await settlement.deployTransaction.wait()).blockNumber}
  fs.writeFileSync(path.join(output, 'deployment.json'), JSON.stringify(manifest, null, 2)+'\n')
  fs.writeFileSync(path.join(output, 'frontend.env'), `REACT_APP_ARC_LOCAL=true\nREACT_APP_ARC_SETTLEMENT=${manifest.settlement}\nREACT_APP_ARC_VAULT_RELAYER=${relayer}\n`)
  console.log('PASS: local Arc settlement, USDC 18/6 units, token approval, EURC delivery, solver authorization')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
