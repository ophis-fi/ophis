import { DAI, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { getAddressKey } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, type Token } from '@cowprotocol/currency'

// OTC containers own this price read; OtcUsdValue remains a data-free view.
// eslint-disable-next-line import/no-internal-modules
import { useUsdAmount } from 'modules/usdAmount'

import type { OtcReviewedToken } from './otcWriteForm'

const TOKEN_BY_ADDRESS = new Map<string, Token>(
  [WETH_MAINNET, USDC_MAINNET, DAI].map((token) => [getAddressKey(token.address), token]),
)

export interface OtcUsdEstimate {
  value: string | null
  isLoading: boolean
}

export function useOtcUsdAmount(token: OtcReviewedToken | null, amount: bigint | null): OtcUsdEstimate {
  const currency = token ? (TOKEN_BY_ADDRESS.get(getAddressKey(token.address)) ?? null) : null
  const currencyAmount = currency && amount ? CurrencyAmount.fromRawAmount(currency, amount.toString()) : null
  const { value, isLoading } = useUsdAmount(currencyAmount)
  return { value: value ? value.toFixed(2) : null, isLoading }
}
