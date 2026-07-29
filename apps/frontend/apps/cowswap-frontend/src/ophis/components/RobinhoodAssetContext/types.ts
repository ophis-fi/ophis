export interface RobinhoodStockDeployment {
  contractAddress: string
  chainId: number
}

export interface RobinhoodTradingCapability {
  whole?: string
  fractional?: string
}

export interface RobinhoodStockAsset {
  id: string
  tokenSymbol: string
  tokenName: string
  deployments: RobinhoodStockDeployment[]
  currentMultiplier: string
  pendingMultiplier?: string
  pendingMultiplierEffectiveTime?: string
  status: string
  logoUrl?: string
  tradingCapabilities?: {
    market?: RobinhoodTradingCapability
    extended?: RobinhoodTradingCapability
    overnight?: RobinhoodTradingCapability
  }
}

export interface RobinhoodAssetsResponse {
  assets: RobinhoodStockAsset[]
}
