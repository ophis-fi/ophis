import { ReactNode } from 'react'

import { getCurrencyAddress } from '@cowprotocol/common-utils'

import { useBridgeSupportedNetwork } from 'entities/bridgeProvider'
import { useAssetVerification } from 'entities/verifiedAsset'

import { CurrencySelectButton, CurrencySelectButtonProps } from 'common/pure/CurrencySelectButton'

export function CurrencySelectButtonContainer(props: CurrencySelectButtonProps): ReactNode {
  const { currency } = props
  const bridgeChain = useBridgeSupportedNetwork(currency?.chainId)
  const verification = useAssetVerification({
    chainId: currency?.chainId,
    address: currency ? (currency.isToken ? currency.address : getCurrencyAddress(currency)) : undefined,
    symbol: currency?.symbol,
    decimals: currency?.decimals,
  })
  return <CurrencySelectButton {...props} verification={verification} bridgeChainLabel={bridgeChain?.label} />
}
