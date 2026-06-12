import { ReactNode } from 'react'

import { useToggleWalletModal } from 'legacy/state/application/hooks'
import { Web3Status } from 'modules/wallet'

import { ActionButton } from './Affiliate.styled'

/**
 * On-page Connect Wallet button for the Profile and Partner pages.
 *
 * Those routes are not trade routes, so the header renders an "Open Trade" link
 * instead of the wallet controls, which means there is no Connect button to
 * point at and, crucially, no WalletModal host mounted. useToggleWalletModal
 * only flips a redux flag, so we also mount a hidden Web3Status here: it
 * self-hosts WalletModal + AccountSelectorModal, and Web3StatusInner renders
 * null under hideConnectButton so nothing visible is added. This is the
 * documented external-CTA pattern (see Web3StatusProps.hideConnectButton).
 */
export function ConnectWalletCta({ children = 'Connect Wallet' }: { children?: ReactNode }): ReactNode {
  const toggleWalletModal = useToggleWalletModal()

  return (
    <>
      <ActionButton type="button" onClick={toggleWalletModal}>
        {children}
      </ActionButton>
      <Web3Status hideConnectButton />
    </>
  )
}
