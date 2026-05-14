import { ReactNode } from 'react'

import { useConnectionType, useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { TradeOrdersPermitUpdater } from 'modules/ordersTable'

import { usePendingActivitiesCount } from 'common/hooks/usePendingActivitiesCount'

import { useShowUnfillableOrderAlert } from '../../hooks/useShowUnfillableOrderAlert'
import { Web3StatusInner } from '../../pure/Web3StatusInner'
import { Wrapper } from '../../pure/Web3StatusInner/styled'
import { AccountSelectorModal } from '../AccountSelectorModal'
import { WalletModal } from '../WalletModal'

export interface Web3StatusProps {
  className?: string
  onClick?: () => void
  joinedLeft?: boolean
  /**
   * When true, the pre-connection "Connect wallet" pill is not rendered.
   * The WalletModal and AccountSelectorModal still mount so external CTAs
   * (e.g. the swap form's Connect Wallet button) can open the modal via Redux.
   */
  hideConnectButton?: boolean
}

export function Web3Status({
  className,
  onClick,
  joinedLeft = false,
  hideConnectButton = false,
}: Web3StatusProps): ReactNode {
  const connectionType = useConnectionType()
  const { account } = useWalletInfo()
  const { ensName } = useWalletDetails()

  const toggleWalletModal = useToggleWalletModal()
  const pendingCount = usePendingActivitiesCount()
  const showUnfillableOrdersAlert = useShowUnfillableOrderAlert()

  return (
    <Wrapper className={className} onClick={onClick} $joinedLeft={joinedLeft}>
      {account && <TradeOrdersPermitUpdater />}
      <Web3StatusInner
        showUnfillableOrdersAlert={showUnfillableOrdersAlert}
        pendingCount={pendingCount}
        account={account}
        ensName={ensName}
        connectWallet={toggleWalletModal}
        connectionType={connectionType}
        hideConnectButton={hideConnectButton}
      />
      <WalletModal />
      <AccountSelectorModal />
    </Wrapper>
  )
}
