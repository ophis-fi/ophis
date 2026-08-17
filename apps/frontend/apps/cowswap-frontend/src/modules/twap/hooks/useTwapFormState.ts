import { useAtomValue } from 'jotai'

import { useIsTxBundlingSupported, useWalletInfo } from '@cowprotocol/wallet'

import { useGetReceiveAmountInfo } from 'modules/trade'
import { tradeFormValidationContextAtom } from 'modules/tradeFormValidation'
import { useUsdAmount } from 'modules/usdAmount'

import { useFallbackHandlerVerification } from './useFallbackHandlerVerification'
import { useTwapOrder } from './useTwapOrder'

import { getTwapFormState, TwapFormState } from '../pure/PrimaryActionButton/getTwapFormState'
import { twapTimeIntervalAtom } from '../state/twapOrderAtom'
import { twapOrdersSettingsAtom } from '../state/twapOrdersSettingsAtom'

export function useTwapFormState(): TwapFormState | null {
  const { chainId } = useWalletInfo()
  const twapOrder = useTwapOrder()

  // TWAP requires ComposableCow + ExtensibleFallbackHandler, which are not
  // deployed on the sovereign chains. Disable the tab instead of no-oping.
  const isUnsupportedChain = (chainId as number) === 10 || (chainId as number) === 130 || (chainId as number) === 4663

  const receiveAmountInfo = useGetReceiveAmountInfo()
  const { sellAmount } = receiveAmountInfo?.beforeAllFees || {}
  const sellAmountPartFiat = useUsdAmount(sellAmount).value

  const partTime = useAtomValue(twapTimeIntervalAtom)
  const { numberOfPartsValue } = useAtomValue(twapOrdersSettingsAtom)
  const tradeFormValidationContext = useAtomValue(tradeFormValidationContextAtom)

  const verification = useFallbackHandlerVerification()
  const isTxBundlingSupported = useIsTxBundlingSupported()

  if (isUnsupportedChain) return null

  return getTwapFormState({
    isTxBundlingSupported,
    verification,
    twapOrder,
    sellAmountPartFiat,
    chainId,
    partTime,
    tradeFormValidationContext,
    numberOfPartsValue,
  })
}
