import type { ReactNode } from 'react'

import { DAI, USDC_MAINNET, WETH_MAINNET } from '@cowprotocol/common-const'
import { CurrencyAmount, type Token } from '@cowprotocol/currency'

import { useUsdAmount } from 'modules/usdAmount'

import * as styledEl from './OtcWrite.styled'

import type { OtcReviewedToken } from './otcWriteForm'

const TOKEN_BY_ADDRESS = new Map<string, Token>(
  [WETH_MAINNET, USDC_MAINNET, DAI].map((token) => [token.address.toLowerCase(), token]),
)

export function OtcUsdValue({ token, amount }: { token: OtcReviewedToken; amount: bigint | null }): ReactNode {
  const currency = TOKEN_BY_ADDRESS.get(token.address.toLowerCase()) ?? null
  const currencyAmount = currency && amount ? CurrencyAmount.fromRawAmount(currency, amount.toString()) : null
  const { value, isLoading } = useUsdAmount(currencyAmount)
  if (!amount) return <styledEl.WriteHint>Enter a positive amount.</styledEl.WriteHint>
  if (isLoading) return <styledEl.WriteHint>Loading USD estimate...</styledEl.WriteHint>
  return (
    <styledEl.WriteHint>{value ? `Approximately $${value.toFixed(2)}` : 'USD estimate unavailable'}</styledEl.WriteHint>
  )
}
