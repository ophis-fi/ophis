import { defineConfig, loadEnv } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  if (!env.RAILGUN_RPC_URL)
    throw new Error('Set RAILGUN_RPC_URL to an explicitly trusted Ethereum RPC or local Anvil fork.')
  if (env.VITE_RAILGUN_ENVIRONMENT && !['fork', 'ethereum'].includes(env.VITE_RAILGUN_ENVIRONMENT))
    throw new Error('Invalid Railgun environment.')
  const headers = {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss: ws://127.0.0.1:4319; worker-src 'self' blob:; img-src 'self' data:; frame-src https://verify.walletconnect.org; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  }
  const proxy = { '^/rpc$': { target: env.RAILGUN_RPC_URL, changeOrigin: true, rewrite: () => '/' } }
  return {
    plugins: [nodePolyfills({ protocolImports: true })],
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
      headers,
      proxy,
    },
    preview: { host: '127.0.0.1', port: 4320, strictPort: true, headers, proxy },
    build: { target: 'es2022', sourcemap: false },
  }
})
