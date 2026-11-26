// Older cached swap documents still request this file to clear their loading overlay.
;(function () {
  let seo = document.getElementById('ophis-seo')
  const root = document.getElementById('root')
  if (!seo || !root) return

  function remove() {
    if (seo && seo.parentNode) seo.parentNode.removeChild(seo)
    seo = null
  }

  if (root.childElementCount > 0) {
    remove()
    return
  }

  const obs = new MutationObserver(function () {
    if (root.childElementCount > 0) {
      remove()
      obs.disconnect()
    }
  })
  obs.observe(root, { childList: true })
})()
