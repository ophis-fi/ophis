import { defineConfig } from 'astro/config'
import preact from '@astrojs/preact'
import rehypeRequireAlt from './scripts/rehype-require-alt.mjs'

export default defineConfig({
  output: 'static',
  site: 'https://ophis.fi',
  trailingSlash: 'never',
  // a11y: fail the build if a post-body markdown image has no alt text.
  markdown: {
    rehypePlugins: [rehypeRequireAlt],
  },
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
