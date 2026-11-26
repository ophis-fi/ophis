import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useEffect } from 'react'

import { useBodyScrollbarLocker } from '@cowprotocol/common-hooks'
import { useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

import { Trans, useLingui } from '@lingui/react/macro'
import { solanaConnectionAtom } from 'entities/solana'

import { toggleAccountSelectorModalAtom } from 'modules/wallet/containers/AccountSelectorModal/state'

import { useCategorizeRecentActivity } from 'common/hooks/useCategorizeRecentActivity'

import * as styledEl from './OrdersPanel.styled'

import { useAccountModalState } from '../../hooks/useAccountModalState'
import { useCloseAccountModalOnNavigate } from '../../hooks/useCloseAccountModalOnNavigate'
import { useCloseAccountModal } from '../../hooks/useToggleAccountModal'
import { AccountDetails } from '../AccountDetails'

// TODO: rename the component into AccountModal
export function OrdersPanel(): ReactNode {
  const { t } = useLingui()
  const { active, account } = useWalletInfo()
  const solana = useAtomValue(solanaConnectionAtom)
  const { ensName } = useWalletDetails()
  const toggleAccountSelectorModal = useSetAtom(toggleAccountSelectorModalAtom)
  const { isOpen } = useAccountModalState()
  const { pendingActivity, confirmedActivity } = useCategorizeRecentActivity()

  const handleCloseOrdersPanel = useCloseAccountModal()

  useCloseAccountModalOnNavigate()

  const hasAccount = !!((active && account) || solana)
  const displayOrdersPanel = isOpen && hasAccount
  useEffect(() => {
    if (isOpen && !hasAccount) handleCloseOrdersPanel()
  }, [isOpen, hasAccount, handleCloseOrdersPanel])

  useBodyScrollbarLocker(displayOrdersPanel)

  if (!displayOrdersPanel) {
    return null
  }

  return (
    <>
      <styledEl.SidebarBackground onClick={handleCloseOrdersPanel} />
      <styledEl.SideBar role="dialog" aria-labelledby="account-panel-title">
        <styledEl.Wrapper>
          <styledEl.Header>
            <strong id="account-panel-title">
              <Trans>Account</Trans>
            </strong>
            <styledEl.CloseButton type="button" aria-label={t`Close account`} onClick={handleCloseOrdersPanel}>
              <styledEl.CloseIcon aria-hidden="true" />
            </styledEl.CloseButton>
          </styledEl.Header>

          <AccountDetails
            ENSName={ensName}
            pendingTransactions={pendingActivity}
            confirmedTransactions={confirmedActivity}
            toggleAccountSelectorModal={toggleAccountSelectorModal}
            handleCloseOrdersPanel={handleCloseOrdersPanel}
          />
        </styledEl.Wrapper>
      </styledEl.SideBar>
    </>
  )
}
