import { defineConfig } from 'astro/config'
import preact from '@astrojs/preact'

export default defineConfig({
  output: 'static',
  site: 'https://ophis.fi',
  trailingSlash: 'never',
  // Note: the missing-alt a11y gate is scripts/check-blog-alt.mjs, run from the
  // `build` script. A rehype throw does NOT work here — the content-layer glob
  // loader isolates per-entry render errors (logged, but build exits 0).
  build: {
    inlineStylesheets: 'auto',
    assets: '_assets',
  },
  integrations: [
    preact({ compat: false }),
  ],
  vite: {
    build: {
      cssMinify: 'lightningcss',
    },
  },
  prefetch: false,
  compressHTML: true,
})
