import type { HttpsString } from '@cowprotocol/cow-sdk'

/**
 * Robinhood Chain icon: black feather (#1c180d) on neon #ccff00, per the
 * correct brand mark supplied by the Robinhood Chain team (2026-08-02); the
 * bare white CDN feather-light glyph previously used here is a monochrome
 * wordmark glyph, not the chain icon. Inlined as a data: URI (same pattern as
 * the Unichain entry in chainInfo.ts): CHAIN_INFO is consumed by multiple
 * apps, so the icon must be origin-independent. Source of truth for the art:
 * apps/frontend/apps/cowswap-frontend/public/logos/chain-robinhood.svg.
 */
export const ROBINHOOD_CHAIN_LOGO =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJSb2Jpbmhvb2QgQ2hhaW4iPgogIDxjaXJjbGUgY3g9IjE2IiBjeT0iMTYiIHI9IjE2IiBmaWxsPSIjY2NmZjAwIi8+CiAgPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoOS40MTMgNy41MDApIHNjYWxlKDAuMTEzNjkpIj4KICAgIDxwYXRoIGZpbGw9IiMxYzE4MGQiIGQ9Im0uODYsMTQ5LjUzaDMuM2MuNiwwLDEuMi0uMywxLjQtLjhDMzAuNDYsODUuMzMsNTcuNTYsNTMuOTMsNzQuNTYsMzUuMTNjLjctLjguNC0xLjQtLjYtMS40aC0zMC40Yy0xLjEsMC0yLjAzLjQ0LTIuOCwxLjRsLTIxLjgsMjdjLTMuMiw0LTQsNy43LTQsMTN2MjcuNkM3Ljg2LDEyMi42MywzLjM2LDEzNi4xMy4wNiwxNDguMzNjLS4yLjc4LjEsMS4yLjgsMS4yWk0xMTAuNTYsNC4wM2MtNC43LTUtMjUuOS01LjItMzUuNy0xLjQtMi4wNC43OS00LDIuMTMtNC45LDIuOS05LDcuNy0xNSwxMy44LTIwLjcsMTkuOC0uNy43LS40LDEuNC42LDEuNGgzMy43YzMuMSwwLDQuOSwxLjgsNC45LDQuOXYzOGMwLDEsLjgsMS4zLDEuNC40bDIwLjMtMjYuNWMzLjMtNC4zLDQuMy01LjYsNS4yLTExLjYsMS4yLTguOC41LTIyLjMtNC44LTI3LjlabS00My41LDEwMC44bDEzLjktMjIuOWMuMy0uNi40LTEuMy40LTEuOHYtMzguMmMwLTEtLjctMS40LTEuNC0uNi0yMC45LDIzLjMtMzcuMiw0Ny44LTUyLjMsNzcuMy0uMzguNzQuMSwxLjQsMSwxLjFsMzEuMi05LjZjMy41Mi0xLjA4LDUuNS0yLjUsNy4yLTUuM1oiLz4KICA8L2c+Cjwvc3ZnPgo=' as HttpsString

export const ROBINHOOD_CHAIN_DOCS = 'https://docs.robinhood.com/chain/' as HttpsString
export const ROBINHOOD_CHAIN_BRIDGE = 'https://docs.robinhood.com/chain/bridging/' as HttpsString
export const ROBINHOOD_CHAIN_EXPLORER = 'https://robinhoodchain.blockscout.com' as HttpsString
export const ROBINHOOD_CHAIN_PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com' as HttpsString
export const ROBINHOOD_STOCK_TOKEN_API = 'https://api.robinhood.com/rhj' as HttpsString
