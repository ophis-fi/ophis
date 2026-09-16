import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { CurrencyAmount } from '@cowprotocol/currency'

import { useTokensBalances } from './useTokensBalances'

export function useCurrencyAmountBalance(
  token: TokenWithLogo | undefined | null,
): CurrencyAmount<TokenWithLogo> | undefined {
  const { values: balances, chainId } = useTokensBalances()

  return useMemo(() => {
    if (!token || token.chainId !== chainId) return undefined

    const balance = balances[token.address.toLowerCase()]

    if (!balance) return undefined

    return CurrencyAmount.fromRawAmount(token, balance.toHexString())
  }, [token, balances, chainId])
}
