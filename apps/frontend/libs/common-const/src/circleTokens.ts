import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { ARC_CIRBTC, ARC_EURC, ARC_USDC, ARC_USYC } from './arc.const'
import {
  USDC_ARBITRUM_ONE,
  USDC_AVALANCHE,
  USDC_BASE,
  USDC_INK,
  USDC_LINEA,
  USDC_MAINNET,
  USDC_OPTIMISM,
  USDC_POLYGON,
  USDC_UNICHAIN,
} from './tokens'

export interface CircleTokenIdentity {
  chainId?: number
  address?: string
  decimals?: number
  symbol?: string
}

// Mainnet issuer records checked 2026-09-25. Imported lists/tags cannot grant this badge.
// https://developers.circle.com/stablecoins/usdc-contract-addresses
// https://developers.circle.com/stablecoins/eurc-contract-addresses
// https://developers.circle.com/assets/cirbtc-contract-addresses
// https://docs.arc.io/arc/references/contract-addresses
const CIRCLE_TOKENS = [
  ARC_USDC,
  ARC_EURC,
  ARC_CIRBTC,
  ARC_USYC,
  USDC_MAINNET,
  USDC_OPTIMISM,
  USDC_UNICHAIN,
  USDC_ARBITRUM_ONE,
  USDC_AVALANCHE,
  USDC_BASE,
  USDC_INK,
  USDC_LINEA,
  USDC_POLYGON,
  { chainId: 9745, address: '0x2d661C89D812261039AF9764eceaAee884f5F67F', decimals: 6, symbol: 'USDC' },
  { chainId: 1, address: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', decimals: 6, symbol: 'EURC' },
  { chainId: 8453, address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6, symbol: 'EURC' },
  { chainId: 43114, address: '0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD', decimals: 6, symbol: 'EURC' },
  { chainId: 9745, address: '0x3EE196E78d4d4248b849B8E1C7F44C5457FAFD2C', decimals: 6, symbol: 'EURC' },
  { chainId: 1, address: '0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E', decimals: 8, symbol: 'cirBTC' },
] as const

export function isCircleToken(token: CircleTokenIdentity | null | undefined): boolean {
  if (!token?.address || !/^0x[\da-f]{40}$/i.test(token.address)) return false
  return CIRCLE_TOKENS.some(
    (known) =>
      token.chainId === known.chainId &&
      token.decimals === known.decimals &&
      token.symbol === known.symbol &&
      areAddressesEqual(token.address, known.address),
  )
}
