"""Starknet source -> Ethereum confirmation and safe wallet rejection regression.
Requires Python Playwright + Chrome and a running Ophis frontend. Uses the live
quote/status API, but the injected test wallet always rejects every transaction.
"""
from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import json
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:4322')
parser.add_argument('--output', default='/tmp/ophis-starknet-browser')
args = parser.parse_args()
OUT=Path(args.output)
OUT.mkdir(parents=True, exist_ok=True)
ADDRESS='0x01'+'11'*31
with sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=True)
 page=b.new_page(viewport={'width':1440,'height':1000})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.add_init_script('''window.walletEvents = {}; window.walletCalls = []; window.starknet_braavos = {id:'braavos',name:'Braavos',version:'1.0.0',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', on:(event,cb)=>{(window.walletEvents[event]??=[]).push(cb)},off:(event,cb)=>{window.walletEvents[event]=(window.walletEvents[event]??[]).filter(x=>x!==cb)},request:async ({type,params})=>{window.walletCalls.push({type,params});if(type==='wallet_getPermissions')return ['accounts'];if(type==='wallet_requestAccounts')return ['''+json.dumps(ADDRESS)+'''];if(type==='wallet_requestChainId')return '0x534e5f4d41494e';if(type==='wallet_addInvokeTransaction')throw {code:113,message:'User rejected'};throw Error(type)}}''')
 def capture(res):
  if res.url.endswith('/v0/quote') and res.request.method=='POST':
   try:(OUT/'quote-response.json').write_text(json.dumps(res.json(),indent=2))
   except:pass
 page.on('response',capture)
 page.goto(args.url.rstrip('/') + '/#/swap');page.locator('.swp-live').wait_for(timeout=90000)
 page.locator('[data-token-picker-trigger]').click();page.get_by_role('dialog').get_by_role('button',name='Starknet',exact=True).click();page.get_by_role('dialog').get_by_text('STRK',exact=True).first.click()
 page.get_by_role('button',name='Connect Starknet wallet',exact=True).click();page.get_by_role('button',name='Connect Braavos',exact=True).click()
 expect(page.get_by_placeholder('Starknet wallet address')).to_have_value(ADDRESS)
 page.locator('#input-currency-input input').fill('90');page.get_by_placeholder('Wallet address, ENS, or .wei name').fill('0x'+'22'*20)
 page.screenshot(path=str(OUT/'connected-1440.png'),full_page=True)
 review=page.get_by_role('button',name='Review swap',exact=True);expect(review).to_be_enabled(timeout=30000);review.click()
 try:page.get_by_role('button',name='Confirm swap',exact=True).wait_for(timeout=45000)
 except:print(page.locator('body').inner_text());raise
 for w in [1440,768,390,320]:
  page.set_viewport_size({'width':w,'height':900});page.wait_for_timeout(300)
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),w
  root=page.get_by_role('region',name='Swap summary',exact=True)
  print(w,root.bounding_box())
  page.screenshot(path=str(OUT/f'review-{w}.png'),full_page=True)
 page.get_by_role('button',name='Confirm swap',exact=True).click();page.get_by_role('button',name='Send with Starknet wallet',exact=True).wait_for(timeout=30000)
 page.get_by_role('button',name='Send with Starknet wallet',exact=True).click()
 page.get_by_text('Transaction declined in your Starknet wallet. No deposit was sent.',exact=True).first.wait_for(timeout=30000)
 page.screenshot(path=str(OUT/'rejected-320.png'),full_page=True)
 assert not errors, errors
 calls=page.evaluate("window.walletCalls.filter(c=>c.type==='wallet_addInvokeTransaction')")
 assert len(calls)==1, calls
 assert calls[0]['params']['calls'][0]['calldata'][1:] == ['0x4e1003b28d9280000','0x0']
 stored=page.evaluate("JSON.parse(localStorage.getItem('nearDirectTransfers:v0'))")
 assert len(stored)==1 and stored[0]['fundingStarted'] is False and not stored[0].get('transactionHash')
 expect(page.get_by_role('button',name='Send with Starknet wallet',exact=True)).to_be_enabled()
 print(json.dumps({'widths':[1440,768,390,320],'connection':True,'confirmation':True,'rejectedTransaction':True,'retryAvailable':True,'pageErrors':errors}))
 (OUT/'browser-errors.json').write_text(json.dumps(errors))
 b.close()
