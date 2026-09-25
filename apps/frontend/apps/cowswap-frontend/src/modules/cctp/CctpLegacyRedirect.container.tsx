import { ReactNode } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { Navigate, useLocation } from 'react-router'

import { parameterizeTradeRoute } from 'modules/trade'

import { Routes } from 'common/constants/routes'

import { cctpToken } from './cctpAssets.const'
import { cctpInitialSelection } from './cctpRoute.utils'

export function CctpLegacyRedirect(): ReactNode {
  const { chainId } = useWalletInfo()
  const { search } = useLocation()
  const { source, destination, asset, swapFirstToken } = cctpInitialSelection(search, chainId)
  const path = parameterizeTradeRoute(
    {
      chainId: String(source),
      inputCurrencyId: swapFirstToken || cctpToken(source, asset),
      outputCurrencyId: cctpToken(swapFirstToken ? source : destination, asset),
      inputCurrencyAmount: undefined,
      outputCurrencyAmount: undefined,
      orderKind: undefined,
    },
    Routes.SWAP,
  )
  return <Navigate replace to={`${path}${swapFirstToken ? '' : `?targetChainId=${destination}`}`} />
}
