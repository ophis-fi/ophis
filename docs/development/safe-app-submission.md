# Ophis — Safe app submission package

This document captures everything needed to submit Ophis to the Safe app store, plus the on-the-wire evidence that Ophis is a valid Safe app today. The actual submission PR against [`safe-global/safe-apps-list`](https://github.com/safe-global/safe-apps-list) lands in **Phase 2.5** (public-launch prep) once we have a real Ophis domain.

## Current app URL

- **Canonical domain:** `https://swap.ophis.fi` (Cloudflare Pages custom domain
  on the `greg` project; the `.pages.dev` deploy URL is internal-only).

## Manifest

Served at `/manifest.json` on the deployment. Contents (`homepage_url` is the canonical `https://swap.ophis.fi`):

```json
{
  "background_color": "#ffffff",
  "display": "standalone",
  "homepage_url": "https://swap.ophis.fi",
  "description": "Ophis — DCA and TWAP for power users on top of CoW Protocol. MEV-protected, gasless, multi-chain.",
  "iconPath": "/android-chrome-512x512.png",
  "icons": [
    { "src": "/android-chrome-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/android-chrome-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ],
  "orientation": "portrait",
  "name": "Ophis",
  "short_name": "Ophis",
  "start_url": ".",
  "theme_color": "#ffffff"
}
```

**`description` length:** 96 characters (Safe spec ≤ 200).
**Icon:** PNG (192×192 + 512×512). Safe ideally wants a square SVG ≥ 128×128; PNG is accepted but a Phase 2.5 task is to add an SVG variant.

## CORS verification

Safe fetches the manifest cross-origin from `app.safe.global`. CORS must allow it.

```
$ curl -sI https://swap.ophis.fi/manifest.json | grep -iE 'access-control|content-type'
access-control-allow-origin: *
content-type: application/json; charset=utf-8
```

✅ Vercel's default behaviour serves static JSON with `Access-Control-Allow-Origin: *`. No `vercel.json` `headers` config needed.

## Iframe load verification

Safe iframes the app URL with `<iframe src="$appUrl" sandbox="...">`. Check for blocking response headers:

```
$ curl -sI https://swap.ophis.fi/ | grep -iE 'x-frame|content-security-policy|frame-ancestors'
(no output)
```

✅ No `X-Frame-Options` header, no restrictive `Content-Security-Policy frame-ancestors`. Safe can iframe Ophis without browser-level blocking.

## Manual iframe test (operator verification)

To visually confirm the iframe loads with cowswap's Safe SDK detecting the Safe parent:

```bash
SAFE_APP_TEST_URL="https://app.safe.global/apps/open?safe=eth%3A0xfb1bffc9d739b8d520daf37df666da4c687191ea&appUrl=$(python3 -c "
import urllib.parse
print(urllib.parse.quote('https://swap.ophis.fi'))
")"
echo "$SAFE_APP_TEST_URL"
# Open in browser; the Ophis UI should render inside Safe's iframe.
```

Cowswap's existing `@safe-global/safe-apps-sdk` integration auto-detects the Safe parent, exposes a "Connect with Safe" option, and uses `SafeAppProvider` for transactions instead of an external wallet. We inherit this for free from upstream — no Ophis-specific code is needed.

## Submission process (Phase 2.5)

1. **Replace the URL above** with the real Ophis domain once it exists.
2. **(Optional)** Add an SVG icon variant at `/greg-icon.svg` (≥128×128 square) and update `iconPath`. Improves Safe app store presentation per their preferred-asset spec.
3. **Open a PR** against [`safe-global/safe-apps-list`](https://github.com/safe-global/safe-apps-list). Follow the format in `community-list.json`. Sample entry:

   ```json
   {
     "id": "<UUID generated when adding entry>",
     "url": "https://<real-greg-domain>",
     "networks": [1, 100, 8453, 42161, 137, 43114, 56, 59144, 11155111]
   }
   ```

   `networks` lists the chainIds where Ophis's app should appear. Match Phase-1.5's CoW-supported set; drop testnets in the production submission (keep Sepolia `11155111` only if Safe's list still allows it).

4. **Wait for review** by the Safe team. Typical turnaround: 1–2 weeks.

5. Once merged, Ophis appears in `app.safe.global`'s "Browse Safe Apps" list — a free, persistent acquisition channel for treasury users. No further engineering needed; refreshing the Safe-list cache picks up the new entry automatically.

## Reference docs (May 2026)

- [How to build a Safe App and get it listed (Safe help center)](https://help.safe.global/en/articles/145503-how-to-build-a-safe-app-and-get-it-listed-in-safe-wallet)
- [`safe-global/safe-apps-list` — community submission process](https://github.com/safe-global/safe-apps-list)
- [`@safe-global/safe-apps-sdk`](https://www.npmjs.com/package/@safe-global/safe-apps-sdk) — already a cowswap dependency; auto-detects Safe parent in iframe contexts.

## Verification log

| Check | Method | Result |
|---|---|---|
| Manifest serves at `/manifest.json` | `curl /manifest.json` returns the object above | ✅ |
| Manifest CORS allows cross-origin fetch | `Access-Control-Allow-Origin: *` | ✅ |
| Manifest contains Ophis-specific values | name/short_name=Greg, description=Greg-specific, homepage_url=Greg URL | ✅ |
| Manifest contains Safe `iconPath` field | `iconPath: /android-chrome-512x512.png` | ✅ |
| Root URL serves HTML 200 | `curl -I /` returns 200 + `text/html` | ✅ |
| No iframe-blocking headers | No X-Frame-Options, no CSP frame-ancestors | ✅ |
| Cowswap's Safe-apps-sdk integration is upstream-supplied | `@safe-global/safe-apps-sdk` in cowswap deps | ✅ |
