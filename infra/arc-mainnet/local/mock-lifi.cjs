// Deterministic local HTTP fixture. Never calls LI.FI or a public RPC.
const http = require('node:http')
const path = require('node:path')
const { createRequire } = require('node:module')
const dependency = createRequire(path.resolve(__dirname, '../../../apps/frontend/apps/cowswap-frontend/package.json'))
const { Interface } = dependency('@ethersproject/abi')
const manifest = require('./generated/deployment.json')
const USDC = '0x3600000000000000000000000000000000000000'
const EURC = '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1'
const ROUTER = '0xA4072583658Fae592A3506A42431cb6316a8d40b'
const router = new Interface(['function swap(address sell,uint256 amount,uint256 output,address receiver)'])
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8787')
  const q = url.searchParams
  const sell = q.get('fromToken')?.toLowerCase()
  const buy = q.get('toToken')?.toLowerCase()
  if (url.pathname !== '/v1/quote' || q.get('fromChain') !== '5042' || q.get('toChain') !== '5042'
      || ![USDC, EURC].includes(sell) || ![USDC, EURC].includes(buy) || sell === buy
      || q.get('fromAddress')?.toLowerCase() !== manifest.settlement.toLowerCase()
      || q.get('toAddress')?.toLowerCase() !== manifest.settlement.toLowerCase()
      || !/^\d+$/.test(q.get('fromAmount') || '')) {
    res.writeHead(400, {'Content-Type':'application/json'}).end(JSON.stringify({message:'Unsupported local route'}))
    return
  }
  const amount = q.get('fromAmount')
  const body = {action:{fromChainId:5042,toChainId:5042}, includedSteps:[{type:'swap',tool:'local-fixture'}],
    estimate:{toAmount:amount,toAmountMin:amount,approvalAddress:ROUTER,gasCosts:[{estimate:'200000'}]},
    transactionRequest:{to:ROUTER,value:'0x0',chainId:5042,data:router.encodeFunctionData('swap',[sell,amount,amount,manifest.settlement])}}
  res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(body))
}).listen(8787, '127.0.0.1', () => console.log('Local LI.FI fixture on 127.0.0.1:8787'))
