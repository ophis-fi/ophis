import { lazy, ReactNode, Suspense } from 'react'

import { Callout } from 'ophis/ds'
import { Link, useLocation } from 'react-router'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { Web3Status } from 'modules/wallet'

import { ActionButton } from './Affiliate.styled'

const SolanaWalletPicker = lazy(() =>
  import('modules/nativeSolana').then((module) => ({ default: module.SolanaWalletPicker })),
)

export function AffiliateNetworkPicker({
  solana,
  needsMessageSigning,
}: {
  solana: boolean
  needsMessageSigning: boolean
}): ReactNode {
  const { pathname, search } = useLocation()
  function link(network: string): string {
    const params = new URLSearchParams(search)
    params.set('network', network)
    return pathname + '?' + params
  }
  return (
    <>
      <nav aria-label="Referral wallet network">
        <Link aria-current={!solana ? 'page' : undefined} to={link('evm')}>
          EVM
        </Link>
        {' · '}
        <Link aria-current={solana ? 'page' : undefined} to={link('solana')}>
          Solana
        </Link>
      </nav>
      {needsMessageSigning && (
        <Callout tone="warning" title="Message signing required">
          <p>
            Connect a wallet that supports Solana message signing to activate a referral or access your partner
            dashboard.
          </p>
          <Suspense fallback={null}>
            <SolanaWalletPicker />
          </Suspense>
        </Callout>
      )}
    </>
  )
}

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
export function ConnectWalletCta({
  children = 'Connect Wallet',
  solana = false,
}: {
  children?: ReactNode
  solana?: boolean
}): ReactNode {
  const toggleWalletModal = useToggleWalletModal()

  if (solana)
    return (
      <Suspense fallback={<span>Loading wallets…</span>}>
        <SolanaWalletPicker />
      </Suspense>
    )

  return (
    <>
      <ActionButton type="button" onClick={toggleWalletModal}>
        {children}
      </ActionButton>
      <Web3Status hideConnectButton />
    </>
  )
}
