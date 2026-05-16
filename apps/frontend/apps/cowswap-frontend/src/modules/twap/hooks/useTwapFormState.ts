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

  // Ophis: TWAP requires ComposableCow + ExtensibleFallbackHandler, which
  // aren't deployed on OP mainnet (Spec 2), MegaETH mainnet (chain 4326), or
  // HyperEVM mainnet (chain 999). Codex review 2026-05-14 flagged the broken-UI
  // promise where the button is reachable but silent no-ops because the SDK's
  // COMPOSABLE_COW_CONTRACT_ADDRESS[10] / [4326] / [999] is undefined.
  // Returning null here makes the TWAP tab clearly disabled instead.
  if ((chainId as number) === 10 || (chainId as number) === 4326 || (chainId as number) === 999) return null

  const receiveAmountInfo = useGetReceiveAmountInfo()
  const { sellAmount } = receiveAmountInfo?.beforeAllFees || {}
  const sellAmountPartFiat = useUsdAmount(sellAmount).value

  const partTime = useAtomValue(twapTimeIntervalAtom)
  const { numberOfPartsValue } = useAtomValue(twapOrdersSettingsAtom)
  const tradeFormValidationContext = useAtomValue(tradeFormValidationContextAtom)

  const verification = useFallbackHandlerVerification()
  const isTxBundlingSupported = useIsTxBundlingSupported()

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
