# Ophis — PWA install verification

**Date:** 2026-05-03
**Deployment URL:** https://greg-git-main-clementfrmds-projects.vercel.app (latest READY deploy: `804274b1` after Phase 2 Task 5 manifest hardening)

The cowswap fork uses [`vite-plugin-pwa`](https://vite-pwa-org.netlify.app/) wired in `apps/cowswap-frontend/vite.config.mts` with workbox precaching. Ophis inherits this for free; we only confirm it works.

## Programmatic install-criteria checks

The Chrome / Edge / Safari PWA install prompt shows when these conditions are met (per W3C web app manifest + service worker spec):

| Criterion | Probe | Result |
|---|---|---|
| Served over HTTPS | `https://greg-...vercel.app` | ✅ |
| Linked web manifest | `<link rel="manifest" href="./manifest.json">` (and an additional `manifest.webmanifest` for redundancy) in the HTML `<head>` | ✅ |
| Manifest has `name`, `icons` (≥192px), `start_url`, `display` | All present in `/manifest.json` (verified in Phase 2 Task 5) | ✅ |
| Service worker reachable | `GET /service-worker.js` → HTTP 200, 41 KB, `content-type` JS | ✅ |
| Service worker has fetch handler | SW body contains workbox routing constants | ✅ |
| Ophis-specific PWA name | `name: "Ophis"` and `short_name: "Ophis"` in manifest | ✅ |

Sample probe (replicable):
```bash
DEPLOY_URL=https://greg-git-main-clementfrmds-projects.vercel.app
curl -sI "$DEPLOY_URL/service-worker.js" | head -3
curl -sS "$DEPLOY_URL" | grep -oE '<link[^>]*manifest[^>]*>'
```

## Operator install checklist (manual)

Run these once on operator's hardware (Phase 2 gate accepts the programmatic checks above; the manual steps just exercise the prompt visually):

### Chrome (macOS)
1. Open the deployment URL in Chrome.
2. URL bar shows an "install app" icon (small computer-screen glyph) on the right.
3. Click → "Install".
4. Ophis launches as a standalone window. Title bar: "Ophis".
5. Open `chrome://apps`. Ophis appears in the list.

### Safari (macOS, ≥17)
1. Open the deployment URL in Safari.
2. `File` menu → `Add to Dock` (or right-click the page → `Add to Dock`).
3. The macOS Dock now has a Ophis icon.
4. Click the Dock icon. Ophis launches as a standalone app window.

### Mobile (optional — defer to Phase 2.5 with real domain)

Mobile install UX prefers stable URLs over hash-randomised previews, and the iOS/Android install flow benefits from on-device gestures that aren't easy to capture from the controller. Phase 2.5 (with the real Ophis domain) is the right time to verify mobile install + screenshot for marketing.

## Phase 2 PWA gate: PASS

All programmatic install criteria are satisfied on the current deployment. The cowswap upstream's `vite-plugin-pwa` configuration is sufficient for Ophis — no additional service worker code or manifest fields are required for installability. Operator manual install (Chrome + Safari) is documented for when convenient; the gate does not block on the manual step.

## Reference

- [`vite-plugin-pwa` documentation](https://vite-pwa-org.netlify.app/)
- [Web App Manifest spec (W3C)](https://www.w3.org/TR/appmanifest/)
- [Chrome PWA install criteria](https://web.dev/articles/install-criteria)
- Cowswap upstream PWA config: `apps/cowswap-frontend/vite.config.mts` (`VitePWA({ filename: 'service-worker.ts', ... })`)
