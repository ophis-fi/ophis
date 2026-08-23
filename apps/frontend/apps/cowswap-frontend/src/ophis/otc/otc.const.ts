import type { OtcManifest } from './otc.types'
import type { Hex } from 'viem'

export const OTC_MAX_ENUMERATED_ORDERS = 1_000
export const OTC_ORDER_BATCH_SIZE = 64
export const OTC_READ_TIMEOUT_MS = 8_000
export const OTC_SUBGRAPH_TIMEOUT_MS = 8_000

/** Milestone C ERC-20-only contract calls. Native-ETH selectors stay disabled. */
export const OTC_ERC20_WRITE_SELECTORS: readonly Hex[] = Object.freeze([
  '0xfc05ca31', // createOrder(address,uint256,address,uint256)
  '0xc37dfc5b', // fillOrder(uint256,uint256)
  '0x514fcac7', // cancelOrder(uint256)
])

/**
 * Ethereum-only, read-only escrow contract identity, verified independently
 * on 2026-08-19 through two public RPC endpoints (publicnode, drpc) plus a
 * Sourcify exact_match (creation AND runtime). Any runtime-hash or weth()
 * wiring mismatch disables all OTC reads — nothing is rendered from an
 * unverified source. Addresses are never taken from remote configuration.
 */
export const OPHIS_ETHEREUM_OTC_MANIFEST: OtcManifest = {
  chainId: 1,
  chainLabel: 'Ethereum',
  contract: {
    address: '0x000000fF3D7A2d373615141d7489Ca66683DbecF',
    runtimeCodeHash: '0x8d9ad2a9d3b3d47aaa832ecc21de8775509764409ab07cdf097640396d10eda1',
  },
  wethAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  deploymentBlock: 24_622_661n,
  orderBatchSize: OTC_ORDER_BATCH_SIZE,
  maxEnumeratedOrders: OTC_MAX_ENUMERATED_ORDERS,
  maxReturnBytes: 32_768,
  callGasLimit: 2_000_000n,
  readTimeoutMs: OTC_READ_TIMEOUT_MS,
  // Upstream-operated public index. Discovery/enrichment hint only, never
  // settlement authority; the UI must degrade gracefully without it.
  subgraphUrl: 'https://api.goldsky.com/api/public/project_cmmkvehnce9da01u17d657vdt/subgraphs/Swapboard/1.0.0/gn',
  subgraphTimeoutMs: OTC_SUBGRAPH_TIMEOUT_MS,
  maxIndexLagBlocks: 60n,
  tokenPolicyProfile: 'otc-escrow',
  enabledTransactionSelectors: OTC_ERC20_WRITE_SELECTORS,
}

/**
 * Every state-changing selector of the deployed contract, pinned as data so
 * the boundary test can prove the read ABI can never encode one. Milestones
 * A/B shipped with all of them unreachable. Milestone C enables only the first
 * three ERC-20 selectors behind a separate local-fork write flag; all four ETH
 * wrappers and the payable receive() remain out of scope.
 */
export const OTC_KNOWN_WRITE_SELECTORS: readonly Hex[] = [
  ...OTC_ERC20_WRITE_SELECTORS,
  '0x97bfdd2f', // createOrderWithEth(address,uint256)
  '0x9fe63676', // fillOrderWithEth(uint256,uint256)
  '0x21dd76f9', // cancelOrderUnwrap(uint256)
  '0xb50430d8', // fillOrderUnwrap(uint256,uint256)
]
