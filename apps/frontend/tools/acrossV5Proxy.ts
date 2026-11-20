import type { ProxyOptions } from 'vite'

const SWAP_ORIGIN = 'https://swap.ophis.fi'

export const acrossV5Proxy: ProxyOptions = {
  target: SWAP_ORIGIN,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (request) => request.setHeader('origin', SWAP_ORIGIN))
  },
}
