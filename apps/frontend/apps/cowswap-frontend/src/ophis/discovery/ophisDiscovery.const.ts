import type { OphisDiscoveryManifest } from './ophisDiscovery.types'
import type { Address } from 'viem'

export const OPHIS_DISCOVERY_MAX_RESULTS = 12
export const OPHIS_DISCOVERY_TIMEOUT_MS = 8_000

/**
 * Ethereum-only, read-only source identity verified independently through three
 * public RPC endpoints on 2026-08-17. Any runtime mismatch disables discovery.
 */
export const OPHIS_ETHEREUM_DISCOVERY_MANIFEST: OphisDiscoveryManifest = {
  chainId: 1,
  chainLabel: 'Ethereum',
  registry: {
    address: '0x0000006013dF75A31678B786061C2B54bf531524',
    runtimeCodeHash: '0x10477f53cc82e19a81783dd087272c53ac293855c9fe094366ef740852897e7f',
  },
  lens: {
    address: '0x000000B73c767CA6F490a666E88D43579579351b',
    runtimeCodeHash: '0xfb5d7d8a386ab97dd99f74a6519788175bad419cd298630fc13680474828735a',
  },
  ranking: {
    address: '0x0000006D936bA3653b8854490E16E782cd32a9a8',
    runtimeCodeHash: '0xf1c9cbbc1e87295c9d16814aa9fce98729d71f2c8793c8299b4c167a9a2cd70f',
  },
  pageSize: OPHIS_DISCOVERY_MAX_RESULTS,
  callGasLimit: 2_000_000n,
  maxReturnBytes: 32_768,
}

/** Display policy only. This list is never reused for routing or token support. */
export const OPHIS_DISCOVERY_EXCLUDED_ADDRESSES: readonly Address[] = ['0xe9B1cfEa55bAA219E34301F2f31B9fd0921664eD']
