import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite'
import { realpathSync } from 'node:fs'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const endpoints: Record<string, string | undefined> = {
    '/rpc': env.RAILGUN_RPC_URL,
    '/rpc/1': env.RAILGUN_RPC_URL,
    '/rpc/42161': env.RAILGUN_ARBITRUM_RPC_URL,
    '/rpc/137': env.RAILGUN_POLYGON_RPC_URL,
    '/rpc/56': env.RAILGUN_BNB_RPC_URL,
  }
  if (!Object.values(endpoints).some(Boolean))
    throw new Error('Set an explicitly trusted Railgun network RPC or local Anvil fork.')
  if (env.VITE_RAILGUN_ENVIRONMENT && !['fork', 'ethereum', 'mainnet'].includes(env.VITE_RAILGUN_ENVIRONMENT))
    throw new Error('Invalid Railgun environment.')
  const headers = {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss: ws://127.0.0.1:4319; worker-src 'self' blob:; img-src 'self' data:; frame-src https://verify.walletconnect.org; frame-ancestors ${env.VITE_RAILGUN_ASSET_BASE === '/private/' ? "'self'" : "'none'"}; base-uri 'none'; form-action 'none'`,
  }
  const proxy = Object.fromEntries(Object.entries(endpoints).flatMap(([path, target]) => target ? [[`^${path}$`, {
    target, changeOrigin: true, prependPath: false, rewrite: () => new URL(target).pathname + new URL(target).search,
  }]] : []))
  return {
    base: env.VITE_RAILGUN_ASSET_BASE || '/',
    plugins: [nodePolyfills({ protocolImports: true }), {
      name: 'private-network-rpc',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = request.url?.split('?')[0] || ''
          if ((path === '/rpc' || path.startsWith('/rpc/')) && !endpoints[path]) {
            response.writeHead(503, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: 'A trusted RPC is not configured for this private network.' }))
            return
          }
          next()
        })
      },
    }],
    optimizeDeps: {
      include: [
        '@railgun-community/wallet',
        '@railgun-community/engine',
        '@railgun-community/shared-models',
        '@railgun-community/waku-broadcaster-client-web',
        'ethers',
        'snarkjs',
        'level-js',
        'levelup',
        'vite-plugin-node-polyfills/shims/buffer',
        'vite-plugin-node-polyfills/shims/global',
        'vite-plugin-node-polyfills/shims/process',
      ],
      exclude: ['@railgun-community/poseidon-hash-wasm', '@railgun-community/curve25519-scalarmult-wasm'],
    },
    server: {
      // Reloading during proof generation can lose the submission response.
      hmr: false,
      host: '127.0.0.1',
      port: 4319,
      strictPort: true,
      fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync('node_modules')] },
      headers,
      proxy,
    },
    preview: { host: '127.0.0.1', port: 4320, strictPort: true, headers, proxy },
    build: { target: 'es2022', sourcemap: false },
  }
})
