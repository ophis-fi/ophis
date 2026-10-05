"""Focused local audit: axe accessibility, nested views, short viewports and lazy loading.
Run alongside start:asset-swap, with installed Chrome and Python Playwright.
No wallet actions or external API/RPC requests are allowed by these browser contexts.
"""
import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright
from playwright.sync_api import expect, sync_playwright

FRONTEND = Path(__file__).resolve().parents[1]
OUT = Path('/tmp/ophis-asset-swap-audit-20261005')
OUT.mkdir(parents=True, exist_ok=True)
AXE = sorted((FRONTEND / 'node_modules/.pnpm').glob('axe-core@*/node_modules/axe-core/axe.min.js'))[-1]
URL = 'http://127.0.0.1:4318'
RESULTS = []


def allow_local(route):
    if route.request.url.startswith(URL) or route.request.resource_type in ('image', 'font'):
        route.continue_()
    else:
        route.abort()


def scan(page, selector, case):
    page.add_script_tag(path=str(AXE))
    violations = page.evaluate('''async selector => (await axe.run(document.querySelector(selector), {
      runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa']}
    })).violations.map(v => ({id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({
      target: n.target, failure: n.failureSummary
    }))}))''', selector)
    RESULTS.append({'case': case, 'violations': violations})
    assert not violations, (case, violations)


def assert_contained(page):
    box = page.locator('.swp-live').bounding_box()
    assert box['y'] >= 0 and box['y'] + box['height'] <= page.viewport_size['height'], box
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')


def browser_checks():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)
        context = browser.new_context(viewport={'width': 1000, 'height': 850})
        context.route('**/*', allow_local)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL + '/#/asset-swap-lab')
        page.locator('.swp-coin').first.wait_for()
        page.wait_for_load_state('networkidle')
        for dark in (False, True):
            if dark:
                page.get_by_role('button', name='Dark theme', exact=True).click()
            scan(page, '.swp-lab', f'demo-closed-dark-{dark}')
            page.locator('.swp-coin').first.click()
            page.wait_for_timeout(650)
            scan(page, '.swp', f'demo-picker-dark-{dark}')
            page.keyboard.press('Escape')
            page.wait_for_timeout(650)
        page.get_by_role('button', name='Dark theme', exact=True).click()
        # Selecting the other coin must exchange the two, never create BTC/BTC.
        page.locator('.swp-coin').last.click()
        page.get_by_role('button', name='BTC Bitcoin', exact=True).click()
        page.wait_for_timeout(650)
        assert page.locator('.swp-coin').all_text_contents() == ['HYPE', 'BTC']
        RESULTS.append({'case': 'demo-duplicate-selection-exchanges-assets', 'passed': True})

        page.goto(URL + '/#/swap')
        page.locator('.swp-live').wait_for()
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(1000)
        live = page.locator('.swp-live')
        # Let the app's entrance fade settle before measuring text contrast.
        page.wait_for_function('''() => {
          for (let el = document.querySelector('.swp-live'); el; el = el.parentElement) {
            if (Number(getComputedStyle(el).opacity) < 0.999) return false
          }
          return true
        }''')
        scan(page, '.swp-live', 'live-closed')
        for index in (0, 1):
            trigger = live.locator('.open-currency-select-button').nth(index)
            trigger.click()
            page.wait_for_timeout(650)
            scan(page, '.swp-live-picker:not([hidden])', f'live-tokens-{index}')
            page.get_by_role('button', name='Manage token lists').click()
            expect(live.get_by_role('button', name='Lists', exact=True)).to_be_focused()
            page.keyboard.press('Escape')
            expect(page.get_by_role('button', name='Manage token lists')).to_be_focused()
            page.keyboard.press('Escape')
            page.wait_for_timeout(650)
            expect(trigger).to_be_focused()
            trigger.click()
            page.wait_for_timeout(650)
            expect(live.locator('#token-search-input')).to_be_visible()
            page.get_by_role('button', name='View all', exact=False).click()
            scan(page, '.swp-inline-network-list', f'live-networks-{index}')
            page.keyboard.press('Escape')
            page.keyboard.press('Escape')
            page.wait_for_timeout(650)
        RESULTS.append({'case': 'settings-escape-and-reopen-both-slabs', 'passed': True})

        for width, height in ((844, 390), (390, 520)):
            page.set_viewport_size({'width': width, 'height': height})
            for index in (0, 1):
                live.locator('.open-currency-select-button').nth(index).click()
                page.wait_for_timeout(650)
                assert_contained(page)
                page.get_by_role('button', name='View all', exact=False).click()
                panel = live.locator('.swp-inline-network-list')
                assert_contained(page)
                page.screenshot(path=str(OUT / f'short-{width}-{height}-{index}.png'), full_page=True)
                page.keyboard.press('Escape')
                page.keyboard.press('Escape')
                page.wait_for_timeout(650)
            RESULTS.append({'case': f'short-window-{width}-{height}', 'passed': True})
        page.set_viewport_size({'width': 1000, 'height': 850})
        live.locator('.open-currency-select-button').last.click()
        page.wait_for_timeout(650)
        page.set_viewport_size({'width': 844, 'height': 390})
        page.wait_for_timeout(650)
        assert_contained(page)
        page.keyboard.press('Escape')
        page.wait_for_timeout(650)
        RESULTS.append({'case': 'resize-with-picker-open', 'passed': True})
        for index in range(8):
            live.locator('.open-currency-select-button').nth(index % 2).click()
            page.keyboard.press('Escape')
            page.wait_for_timeout(30)
        page.wait_for_timeout(700)
        expect(page.get_by_role('button', name='Reverse swap direction')).to_be_enabled()
        assert not errors, errors
        RESULTS.append({'case': 'rapid-open-close', 'passed': True, 'pageErrors': errors})
        browser.close()


async def slow_motion_chunk():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel='chrome', headless=True)
        context = await browser.new_context(viewport={'width': 1000, 'height': 850})
        gate = asyncio.Event()
        async def route_request(route):
            url = route.request.url
            if '/framer-motion.js' in url:
                await gate.wait()
            if url.startswith(URL) or route.request.resource_type in ('image', 'font'):
                await route.continue_()
            else:
                await route.abort()
        await context.route('**/*', route_request)
        page = await context.new_page()
        await page.goto(URL + '/#/swap', wait_until='domcontentloaded')
        try:
            await page.get_by_role('status').filter(has_text='Loading swap controls').wait_for(timeout=20000)
            assert await page.locator('header').first.is_visible()
            await page.screenshot(path=str(OUT / 'motion-loading.png'), full_page=True)
        finally:
            gate.set()
        await page.locator('.swp-live').wait_for()
        RESULTS.append({'case': 'cold-motion-chunk-keeps-page-visible', 'passed': True})
        await browser.close()


if __name__ == '__main__':
    try:
        browser_checks()
        asyncio.run(slow_motion_chunk())
    finally:
        (OUT / 'browser-audit.json').write_text(json.dumps(RESULTS, indent=2))
    print(json.dumps(RESULTS, indent=2))
