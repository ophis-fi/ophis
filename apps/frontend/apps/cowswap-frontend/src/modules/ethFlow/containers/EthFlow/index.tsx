import { useAtomValue } from 'jotai'
import { ReactNode, useEffect, useMemo } from 'react'

import { useCurrencyAmountBalance } from '@cowprotocol/balances-and-allowances'
import { getWrappedToken } from '@cowprotocol/common-utils'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { Command } from '@cowprotocol/types'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useSingleActivityDescriptor } from 'legacy/hooks/useRecentActivity'
import { WrapUnwrapCallback } from 'legacy/hooks/useWrapCallback'

import {
  useApproveState,
  useIsPartialApproveSelectedByUser,
  usePartialApproveAmountModalState,
  useTradeApproveCallback,
  useUpdatePartialApproveAmountModalState,
} from 'modules/erc20Approve'
import { useWrappedToken } from 'modules/trade'

import useNativeCurrency from 'lib/hooks/useNativeCurrency'

import { useEthFlowActions } from './hooks/useEthFlowActions'
import useRemainingNativeTxsAndCosts from './hooks/useRemainingNativeTxsAndCosts'
import { useSetupEthFlow } from './hooks/useSetupEthFlow'
import { getDerivedEthFlowState } from './utils/getDerivedEthFlowState'

import { EthFlowModalContent } from '../../pure/EthFlowModalContent'
import { WrappingPreviewProps } from '../../pure/WrappingPreview'
import { ethFlowContextAtom } from '../../state/ethFlowContextAtom'

export interface EthFlowProps {
  nativeInput?: CurrencyAmount<Currency>
  approvalInput: CurrencyAmount<Currency> | undefined
  hasEnoughWrappedBalanceForSwap: boolean
  wrapCallback: WrapUnwrapCallback | null
  directSwapCallback: Command
  onDismiss: Command
}

export function EthFlowModal({
  nativeInput,
  approvalInput,
  onDismiss,
  wrapCallback,
  directSwapCallback,
  hasEnoughWrappedBalanceForSwap,
}: EthFlowProps): ReactNode {
  const { chainId } = useWalletInfo()
  const native = useNativeCurrency()
  const wrapped = useWrappedToken()
  // 2026-05-17 hardening: short-circuit out when wallet is on an unsupported
  // chain (useNativeCurrency / useWrappedToken both return undefined). The
  // ETH-flow modal is meaningless on a chain we don't list, and downstream
  // calls (useCurrencyAmountBalance, EthFlowProps cast) need a real Currency.
  const ethFlowReady = !!native && !!wrapped

  const wrappedAmount = useMemo(() => {
    if (!approvalInput) return null

    return CurrencyAmount.fromRawAmount(getWrappedToken(approvalInput.currency), approvalInput.quotient)
  }, [approvalInput])
  const { state: approvalState } = useApproveState(wrappedAmount)

  const ethFlowContext = useAtomValue(ethFlowContextAtom)

  const { amountSetByUser } = usePartialApproveAmountModalState() || {}
  const updatePartialApproveAmountModalState = useUpdatePartialApproveAmountModalState()
  const isPartialApproveSelectedByUser = useIsPartialApproveSelectedByUser()
  const currencyToApprove = isPartialApproveSelectedByUser ? (amountSetByUser ?? wrappedAmount) : undefined

  const approveCallback = useTradeApproveCallback(wrapped)

  const ethFlowActions = useEthFlowActions(
    {
      wrap: wrapCallback,
      approve: approveCallback,
      dismiss: onDismiss,
      directSwap: directSwapCallback,
    },
    currencyToApprove ? BigInt(currencyToApprove?.quotient.toString()) : undefined,
  )

  useEffect(() => {
    return () => {
      // Reset amount user amount after eth flow is closed
      updatePartialApproveAmountModalState({ amountSetByUser: undefined })
    }
  }, [updatePartialApproveAmountModalState])

  const approveActivity = useSingleActivityDescriptor({ chainId, id: ethFlowContext.approve.txHash || undefined })
  const wrapActivity = useSingleActivityDescriptor({ chainId, id: ethFlowContext.wrap.txHash || undefined })

  const nativeBalance = useCurrencyAmountBalance(native ?? undefined)
  const wrappedBalance = useCurrencyAmountBalance(wrapped ?? undefined)
  const nativeSpendAmount = useMemo(
    () =>
      nativeInput && hasEnoughWrappedBalanceForSwap
        ? CurrencyAmount.fromRawAmount(nativeInput.currency, '0')
        : nativeInput,
    [nativeInput, hasEnoughWrappedBalanceForSwap],
  )

  // user safety checks to make sure any on-chain native currency operations are economically safe
  // shows user warning with remaining available TXs if a certain threshold is reached
  const { balanceChecks } = useRemainingNativeTxsAndCosts({
    native,
    nativeBalance,
    nativeInput: nativeSpendAmount,
  })

  const state = useMemo(() => getDerivedEthFlowState(ethFlowContext), [ethFlowContext])

  useSetupEthFlow({
    hasEnoughWrappedBalanceForSwap,
    approvalState,
    approveActivity,
    wrapActivity,
    onDismiss,
  })

  // Early-out for unsupported wallet chains (post-hooks to preserve hook
  // call order). ETH-flow is wrap-and-swap on a native gas token; if the
  // wallet's chain isn't in our TargetChainId set, none of this UI applies.
  if (!ethFlowReady || !native || !wrapped) return null

  const wrappingPreview: WrappingPreviewProps = {
    native,
    nativeBalance,
    wrapped,
    wrappedBalance,
    // Wrapping uses the same buffered amount whenever a deposit is needed.
    amount: approvalInput,
  }

  return (
    <EthFlowModalContent
      state={state}
      ethFlowContext={ethFlowContext}
      ethFlowActions={ethFlowActions}
      balanceChecks={balanceChecks}
      wrappingPreview={wrappingPreview}
      onDismiss={onDismiss}
    />
  )
}
