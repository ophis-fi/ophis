import { defineConfig } from 'vite'

// No plugin: Vite compiles TSX itself (tsconfig "jsx": "react-jsx"). The app is built, then served by
// the Worker's assets binding, in development too, so the strict policy of public/_headers always applies.
export default defineConfig({
  // 0: no asset becomes a data: URI, which the policy (img-src 'self', font-src 'self') would refuse.
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
})
