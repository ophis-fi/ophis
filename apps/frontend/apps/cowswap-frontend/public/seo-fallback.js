// Removes the crawler/loading SEO view (#ophis-seo) once the SPA has mounted
// into #root.
//
// The #ophis-seo block (see index.html) is real, visible, crawlable content
// served in the initial HTML — the indexable surface for this client-rendered
// SPA, which has no SSR. For JS clients we REMOVE it (not display:none) the
// instant React renders, so there is no duplicate heading and no hidden-text /
// cloaking signal in the rendered DOM. For non-JS crawlers and AI bots
// (GPTBot/ClaudeBot/PerplexityBot, allowed in robots.txt) the content simply
// stays.
//
// This lives in an EXTERNAL file, not an inline <script>, because the swap-host
// CSP is `script-src 'self'` with NO 'unsafe-inline' (see public/_headers) —
// an inline script would be silently blocked in production.
(function () {
  var seo = document.getElementById('ophis-seo')
  var root = document.getElementById('root')
  if (!seo || !root) return

  function remove() {
    if (seo && seo.parentNode) seo.parentNode.removeChild(seo)
    seo = null
  }

  // App already mounted (e.g. cached/instant render) — remove immediately.
  if (root.childElementCount > 0) {
    remove()
    return
  }

  // React mounts by appending element children to #root.
  var obs = new MutationObserver(function () {
    if (root.childElementCount > 0) {
      remove()
      obs.disconnect()
    }
  })
  obs.observe(root, { childList: true })

  // Deliberately NO time-based removal: if the app never mounts (bundle, chunk,
  // CSP, or network failure), the crawlable #ophis-seo content must PERSIST
  // rather than be cleared into a blank #root. We only remove it once React has
  // actually rendered children into #root (the MutationObserver above).
})()
