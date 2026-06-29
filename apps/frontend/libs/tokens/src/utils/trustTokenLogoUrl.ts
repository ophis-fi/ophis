import { SupportedChainId } from '@cowprotocol/cow-sdk'

const chainIdToName: Record<SupportedChainId, string | null> = {
  [SupportedChainId.MAINNET]: 'ethereum',
  [SupportedChainId.GNOSIS_CHAIN]: 'xdai',
  [SupportedChainId.ARBITRUM_ONE]: 'arbitrum',
  [SupportedChainId.BASE]: 'base',
  [SupportedChainId.SEPOLIA]: 'ethereum',
  [SupportedChainId.POLYGON]: 'polygon',
  [SupportedChainId.AVALANCHE]: 'avalanche',
  [SupportedChainId.BNB]: 'smartchain',
  [SupportedChainId.LINEA]: 'linea',
  [SupportedChainId.PLASMA]: 'plasma',
  [SupportedChainId.INK]: null, // As of now (2026/01/23), Ink is not on Trust Wallet assets repo
  // Ophis fork: OP mainnet (chain 10)
  [10 as unknown as SupportedChainId]: 'optimism',
  // Ophis fork: Unichain mainnet (chain 130)
  [130 as unknown as SupportedChainId]: 'unichain',
  // Ophis fork: MegaETH mainnet (chain 4326) — not on Trust Wallet assets repo
  [4326 as unknown as SupportedChainId]: null,
  // Ophis fork: HyperEVM mainnet (chain 999) — not on Trust Wallet assets repo
  [999 as unknown as SupportedChainId]: null,
}

/**
 * @deprecated TODO5(daniel)
 */
export function trustTokenLogoUrl(address: string, chainId: SupportedChainId): string | null {
  const trustChainName = chainIdToName[chainId]

  if (!trustChainName) {
    return null
  }

  // TODO: Never point to master! Use a specific commit hash or tag.
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${trustChainName}/assets/${address}/logo.png`
}
