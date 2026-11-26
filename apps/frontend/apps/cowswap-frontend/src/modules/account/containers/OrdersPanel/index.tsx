import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useEffect } from 'react'

import Close from '@cowprotocol/assets/images/x.svg?react'
import { useBodyScrollbarLocker } from '@cowprotocol/common-hooks'
import { Media, UI } from '@cowprotocol/ui'
import { useWalletDetails, useWalletInfo } from '@cowprotocol/wallet'

import { Trans, useLingui } from '@lingui/react/macro'
import { transparentize } from 'color2k'
import { solanaConnectionAtom } from 'entities/solana'
import styled from 'styled-components/macro'

import { toggleAccountSelectorModalAtom } from 'modules/wallet/containers/AccountSelectorModal/state'

import { useCategorizeRecentActivity } from 'common/hooks/useCategorizeRecentActivity'

import { useAccountModalState } from '../../hooks/useAccountModalState'
import { useCloseAccountModalOnNavigate } from '../../hooks/useCloseAccountModalOnNavigate'
import { useCloseAccountModal } from '../../hooks/useToggleAccountModal'
import { AccountDetails } from '../AccountDetails'
import { LowerSection, Wrapper as AccountContent } from '../AccountDetails/styled'

const SidebarBackground = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  z-index: 99;
  width: 100%;
  height: 100%;
  background: ${({ theme }) => (theme.isWidget ? 'transparent' : transparentize(theme.black, 0.1))};
  backdrop-filter: blur(3px);

  ${Media.upToSmall()} {
    display: none;
    &:has(+ [role='dialog'] [data-swap-receipt]) {
      display: block;
    }
  }
`

const Header = styled.div`
  width: 100%;
  display: flex;
  justify-content: space-between;
  padding: 20px 30px;
  align-items: center;
  transition: opacity var(${UI.ANIMATION_DURATION}) ease-in-out;
  color: inherit;
  background: var(${UI.COLOR_PAPER});
  position: sticky;
  top: 0;
  left: 0;
  z-index: 20;

  ${Media.upToMedium()} {
    top: 0;
    padding: 0 16px;
    z-index: 99999;
    position: sticky;
    left: 0;
    height: 52px;
    background: var(${UI.COLOR_PAPER});
  }

  &:hover {
    cursor: pointer;
    opacity: 1;
  }

  > strong {
    font-size: 24px;
    color: inherit;

    ${Media.upToSmall()} {
      font-size: 18px;
    }
  }
`

const CloseIcon = styled((props) => <Close {...props} />)`
  --size: 20px;
  opacity: 0.6;
  transition: opacity var(${UI.ANIMATION_DURATION}) ease-in-out;
  color: var(${UI.COLOR_TEXT});
  width: var(--size);
  height: var(--size);
  object-fit: contain;

  &:hover {
    opacity: 1;
  }
`

const CloseButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  background: none;
  border: none;
  cursor: pointer;
`

const Wrapper = styled.div`
  display: flex;
  flex-flow: row wrap;
  align-items: stretch;
  align-content: flex-start;
  height: inherit;
  width: 100%;
  overflow-y: auto; // fallback for 'overlay'
  overflow-y: overlay;
  ${({ theme }) => theme.colorScrollbar};
`

const SideBar = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  flex-flow: row wrap;
  position: fixed;
  top: 0;
  right: 0;
  width: 100%;
  max-width: 850px;
  height: 80vh;
  height: 80dvh;
  border-radius: 24px;
  margin: auto;
  bottom: 0;
  left: 0;
  z-index: 100;
  padding: 0;
  cursor: default;
  overflow-y: hidden;
  box-shadow: ${({ theme }) => theme.boxShadow1};
  background: var(${UI.COLOR_PAPER});

  ${Media.upToMedium()} {
    width: 100%;
    height: 100%;
    max-width: 100%;
    border-radius: ${({ theme }) => (theme.isWidget ? '24px' : '0')};
  }

  ${Media.upToSmall()} {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  &:has([data-swap-receipt]) {
    display: block;
    width: min(470px, calc(100% - 24px));
    height: fit-content;
    max-height: calc(100dvh - 24px);
    overflow-y: auto;
    border-radius: 20px;

    ${Wrapper}, ${LowerSection} {
      height: auto;
      overflow: visible;
    }

    ${Header} {
      height: auto;
      padding: 4px 12px 0 20px;
    }

    ${Header} > strong {
      font-size: 16px;
    }

    ${AccountContent} {
      padding: 0;
    }

    ${AccountContent} > :not(${LowerSection}), ${LowerSection} > :not([data-swap-receipt]) {
      display: none;
    }

    [data-swap-receipt] {
      border: 0;
      padding-top: 4px;
    }
  }
`

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
      <SidebarBackground onClick={handleCloseOrdersPanel} />
      <SideBar role="dialog" aria-labelledby="account-panel-title">
        <Wrapper>
          <Header>
            <strong id="account-panel-title">
              <Trans>Account</Trans>
            </strong>
            <CloseButton type="button" aria-label={t`Close account`} onClick={handleCloseOrdersPanel}>
              <CloseIcon aria-hidden="true" />
            </CloseButton>
          </Header>

          <AccountDetails
            ENSName={ensName}
            pendingTransactions={pendingActivity}
            confirmedTransactions={confirmedActivity}
            toggleAccountSelectorModal={toggleAccountSelectorModal}
            handleCloseOrdersPanel={handleCloseOrdersPanel}
          />
        </Wrapper>
      </SideBar>
    </>
  )
}
