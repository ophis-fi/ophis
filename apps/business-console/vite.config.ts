import { defineConfig } from 'vite'

// No plugin: Vite compiles TSX itself (tsconfig "jsx": "react-jsx"). The app is built, then served by
// the Worker's assets binding, in development too, so the strict policy of public/_headers always applies.
// Three builds: the console (dist/), then `--mode sign`, the signing page (dist/sign/, every file of it under /sign/), then
// `--mode operator`, the operator's review page (dist/operator/, served on the operator's host only).
// Separate builds share no chunk, so the console's bundle holds no wallet code and the signing host serves /sign/ only.
// 0: no asset becomes a data: URI, which the policy (img-src 'self', font-src 'self') would refuse.
const build = { sourcemap: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } } as const
export default defineConfig(({ mode }) => mode === 'sign' || mode === 'operator'
  ? { root: mode, base: `/${mode}/`, build: { ...build, outDir: `../dist/${mode}`, emptyOutDir: true } }
  : { build: { ...build, outDir: 'dist' } })
