import { defineConfig } from 'astro/config'
import preact from '@astrojs/preact'

export default defineConfig({
  output: 'static',
  site: 'https://ophis.fi',
  trailingSlash: 'never',
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
