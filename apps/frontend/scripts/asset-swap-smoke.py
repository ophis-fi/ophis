"""Exercise the local AssetSwap preview without making RPC calls or submitting trades.
Run with the preview server started: uv run --with playwright python scripts/asset-swap-smoke.py
"""
from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import json
import re
out=Path('/tmp/asset-swap-checks');out.mkdir(parents=True,exist_ok=True);results=[]
def allow_local(r):
 if r.request.url.startswith(('http://127.0.0.1:4318','data:','blob:')) or r.request.resource_type in ('image','font'): r.continue_()
 else: r.abort()

def check_network_panel(page, live, width, index):
 """View all must stay inside either slab, including its nested keyboard flow."""
 button=live.locator('.swp-live-card').nth(index).locator('.open-currency-select-button')
 button.click();page.wait_for_timeout(650)
 more=live.get_by_role('button',name=re.compile(r'^View all'))
 token_search=live.locator('#token-search-input')
 token_search.fill('USDC')
 more.click()
 panel=live.locator('.swp-inline-network-list');expect(panel).to_be_visible()
 bounds=panel.bounding_box();outer=live.bounding_box()
 assert all(abs(bounds[key]-outer[key])<2 for key in ('x','y','width','height')),(bounds,outer)
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
 back=panel.get_by_role('button',name='Back to tokens',exact=True)
 expect(back).to_be_focused()
 page.keyboard.press('Shift+Tab');expect(panel.locator('button').last).to_be_focused()
 page.keyboard.press('Tab');expect(back).to_be_focused()
 # Keyboard navigation scrolls the long network list without moving the slab.
 assert abs(panel.bounding_box()['y']-bounds['y'])<2
 page.screenshot(path=str(out/f'network-picker-{width}-{index}.png'),full_page=True)
 back.click();expect(panel).to_have_count(0);expect(more).to_be_focused()
 expect(token_search).to_have_value('USDC')
 more.click();page.keyboard.press('Escape')
 expect(panel).to_have_count(0);expect(more).to_be_focused()
 expect(live.get_by_role('dialog')).to_have_count(1)
 more.click();search=panel.get_by_placeholder('Search network')
 search.fill('no-such-network');expect(panel.get_by_text('No networks match',exact=False)).to_be_visible()
 search.fill('Base')
 base=panel.get_by_role('button',name='Base Base',exact=True)
 # Offline quote checks deliberately disable cross-chain destination networks.
 # Exercise an actual source-chain change, and the enabled current destination.
 selected='Base' if base.get_attribute('aria-disabled')=='false' else 'Ethereum'
 search.fill(selected);panel.get_by_role('button',name=f'{selected} {selected}',exact=True).click()
 expect(panel).to_have_count(0)
 expect(live.get_by_label(f'Selected network {selected}',exact=True)).to_be_visible()
 more.click();expect(panel.get_by_role('button',name=f'{selected} {selected}',exact=True)).to_have_attribute('aria-pressed','true')
 panel.get_by_placeholder('Search network').fill('Ethereum')
 panel.get_by_role('button',name='Ethereum Ethereum',exact=True).click()
 expect(live.get_by_label('Selected network Ethereum',exact=True)).to_be_visible()
 page.keyboard.press('Escape');page.wait_for_timeout(650)
 expect(live.get_by_role('dialog')).to_have_count(0);expect(button).to_be_focused()
with sync_playwright() as p:
 browser=p.chromium.launch(channel='chrome',headless=True)
 for width in (320,390,768,1440):
  context=browser.new_context(viewport={'width':width,'height':667 if width==320 else 844 if width==390 else 950},is_mobile=width<500,has_touch=width<500)
  context.route('**/*',allow_local)
  page=context.new_page(); errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('http://127.0.0.1:4318/#/asset-swap-lab');page.locator('.swp-coin').first.wait_for();page.wait_for_timeout(700)
  for dark in (False,True):
   if dark:page.get_by_role('button',name='Dark theme',exact=True).click()
   page.wait_for_timeout(150)
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'demo overflow {width}'
   root=page.locator('.swp');rgb=root.evaluate('el=>getComputedStyle(el).getPropertyValue("--fill-on-rgb")')
   assert rgb.strip()==('244, 244, 245' if dark else '23, 25, 28'),rgb
   assert page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--fill-on-rgb")')==''
   root.locator('.swp-coin').last.click();page.wait_for_timeout(650)
   expect(page.get_by_role('button',name='Close',exact=True)).to_be_focused()
   page.keyboard.press('Shift+Tab');expect(root.locator('.swp-pick-row').last).to_be_focused()
   page.keyboard.press('Tab');expect(page.get_by_role('button',name='Close',exact=True)).to_be_focused()
   page.keyboard.press('Escape');page.wait_for_timeout(650)
   expect(root.locator('.swp-coin').last).to_be_focused()
   expect(root.locator('.swp-flip')).to_be_enabled()
   if width in (320,390):page.screenshot(path=str(out/f'demo-{width}-{"dark" if dark else "light"}.png'),full_page=True)
   results.append({'view':'demo','width':width,'dark':dark,'rgb':rgb,'keyboard':True})
  page.goto('http://127.0.0.1:4318/#/swap');page.locator('.swp-live').wait_for();page.wait_for_timeout(1000)
  live=page.locator('.swp-live')
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'swap overflow {width}'
  page.locator('#input-currency-input input').fill('2.5')
  assert page.locator('#input-currency-input input').input_value()=='2.5'
  before=live.locator('.open-currency-select-button').all_text_contents()
  arrow=live.get_by_role('button',name='Reverse swap direction')
  arrow.click();page.wait_for_timeout(700)
  assert live.locator('.open-currency-select-button').all_text_contents()==before
  expect(arrow).to_be_enabled()
  for index in (0,1):
   card=live.locator('.swp-live-card').nth(index)
   page.evaluate('(el)=>window.testSlab=el',card.element_handle())
   button=card.locator('.open-currency-select-button')
   button.click();dialog=live.get_by_role('dialog');dialog.wait_for();page.wait_for_timeout(650)
   assert dialog.evaluate('el=>el===window.testSlab')
   bounds=dialog.bounding_box();outer=live.bounding_box()
   assert abs(bounds['height']-outer['height'])<2,(bounds,outer)
   assert bounds['x']>=0 and bounds['x']+bounds['width']<=width+1
   assert bounds['y']>=0 and bounds['y']+bounds['height']<=page.viewport_size['height']
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
   assert dialog.locator('input').count()>0,'missing real token search'
   page.screenshot(path=str(out/f'live-picker-{width}-{index}.png'),full_page=True)
   page.keyboard.press('Escape');page.wait_for_timeout(650)
   expect(live.get_by_role('dialog')).to_have_count(0);expect(arrow).to_be_enabled()
   expect(button).to_be_focused()
  page.screenshot(path=str(out/f'live-{width}.png'),full_page=True)
  for index in (0,1):check_network_panel(page,live,width,index)
  assert not errors,errors
  results.append({'view':'live','width':width,'reversal':True,'twoInlinePickers':True,'inlineNetworks':True,'errors':errors})
  context.close()
 # Motion preference changes must never strand a lifted slab or hidden arrow.
 context=browser.new_context(viewport={'width':390,'height':844},reduced_motion='reduce');context.route('**/*',allow_local)
 page=context.new_page();page.goto('http://127.0.0.1:4318/#/asset-swap-lab');page.locator('.swp-coin').first.wait_for()
 page.locator('.swp-coin').first.click();page.get_by_role('dialog').wait_for();page.keyboard.press('Escape');page.wait_for_timeout(100)
 expect(page.locator('.swp-flip')).to_be_enabled()
 page.locator('.swp-flip').click();page.wait_for_timeout(100)
 assert page.locator('.swp-label').all_text_contents()==['You receive','You pay']
 page.locator('.swp-coin').first.click();page.get_by_label('Assets',exact=True).select_option('Currency');page.wait_for_timeout(100)
 expect(page.get_by_role('dialog')).to_have_count(0);expect(page.locator('.swp-flip')).to_be_enabled()
 assert page.locator('.swp-coin').all_text_contents()==['USD','EUR']
 page.goto('http://127.0.0.1:4318/#/swap');page.locator('.swp-live').wait_for();page.wait_for_timeout(500)
 arrow=page.get_by_role('button',name='Reverse swap direction');arrow.click();page.wait_for_timeout(100);expect(arrow).to_be_disabled()
 page.wait_for_timeout(450);expect(arrow).to_be_enabled()
 page.locator('.swp-live .open-currency-select-button').first.click();page.get_by_role('dialog').wait_for();page.keyboard.press('Escape');page.wait_for_timeout(100);expect(arrow).to_be_enabled()
 results.append({'view':'reduced-motion','demoAndLive':True,'setChangeClosesPicker':True})
 browser.close()
(out/'responsive-results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
