import { ReactNode, useRef, type MouseEvent } from 'react'

import { getChainInfo } from '@cowprotocol/common-const'
import { useAvailableChains, useBodyScrollbarLocker, useMediaQuery, useOnClickOutside } from '@cowprotocol/common-hooks'
import { Media } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Trans, useLingui } from '@lingui/react/macro'
import { createPortal } from 'react-dom'
import { useTheme } from 'styled-components/macro'

import { useModalIsOpen, useToggleModal } from 'legacy/state/application/hooks'
import { ApplicationModal } from 'legacy/state/application/reducer'

import { useIsProviderNetworkUnsupported } from 'common/hooks/useIsProviderNetworkUnsupported'
import { useOnSelectNetwork } from 'common/hooks/useOnSelectNetwork'
import { useShouldHideNetworkSelector } from 'common/hooks/useShouldHideNetworkSelector'
import { NetworksList } from 'common/pure/NetworksList/NetworksList.pure'

import * as styledEl from './NetworkSelector.styled'

type OnSelectNetwork = ReturnType<typeof useOnSelectNetwork>
type OnSelectNetworkTarget = Parameters<OnSelectNetwork>[0]

const stopPropagation = (event: MouseEvent<HTMLDivElement>): void => {
  event.stopPropagation()
}

const createCloseHandler =
  (isOpen: boolean, toggleModal: () => void) =>
  (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (isOpen) {
      toggleModal()
    }
  }

const createSelectHandler =
  (isOpen: boolean, toggleModal: () => void, onSelectChain: OnSelectNetwork) =>
  (targetChainId: OnSelectNetworkTarget): void => {
    if (isOpen) {
      toggleModal()
    }
    void onSelectChain(targetChainId, true)
  }

export function NetworkSelector(): ReactNode {
  const { chainId } = useWalletInfo()
  const node = useRef<HTMLDivElement>(null)
  const nodeMobile = useRef<HTMLDivElement>(null)
  const nodeSelector = useRef<HTMLDivElement>(null)
  const isOpen = useModalIsOpen(ApplicationModal.NETWORK_SELECTOR)
  const toggleModal = useToggleModal(ApplicationModal.NETWORK_SELECTOR)
  const isChainIdUnsupported = useIsProviderNetworkUnsupported()
  const info = getChainInfo(chainId)
  const isUpToMedium = useMediaQuery(Media.upToMedium(false))
  const shouldHideNetworkSelector = useShouldHideNetworkSelector()
  useOnClickOutside(isUpToMedium ? [nodeMobile, nodeSelector] : [node], () => {
    if (isOpen) {
      toggleModal()
    }
  })

  useBodyScrollbarLocker(isOpen && !shouldHideNetworkSelector, Media.upToMedium(false))

  const onSelectChain = useOnSelectNetwork()
  const { darkMode: isDarkMode } = useTheme()
  const logoUrl = isDarkMode ? info.logo.dark : info.logo.light
  const availableChains = useAvailableChains()
  const { t } = useLingui()

  const handleClose = createCloseHandler(isOpen, toggleModal)
  const handleSelectChain = createSelectHandler(isOpen, toggleModal, onSelectChain)

  if (shouldHideNetworkSelector) {
    return null
  }

  const flyoutMenu = (
    <styledEl.FlyoutMenu>
      <styledEl.FlyoutMenuContents ref={nodeMobile} onClick={stopPropagation}>
        <styledEl.FlyoutMenuScrollable>
          <styledEl.FlyoutHeader>
            <styledEl.FlyoutHeaderTitle>
              <Trans>Select a network</Trans>
            </styledEl.FlyoutHeaderTitle>
            <styledEl.CloseButton type="button" aria-label={t`Close`} onClick={handleClose}>
              <styledEl.CloseIcon aria-hidden="true" />
            </styledEl.CloseButton>
          </styledEl.FlyoutHeader>
          <styledEl.FlayoutMenuList>
            <NetworksList
              currentChainId={isChainIdUnsupported ? null : chainId}
              isDarkMode={isDarkMode}
              onSelectChain={handleSelectChain}
              availableChains={availableChains}
            />
          </styledEl.FlayoutMenuList>
        </styledEl.FlyoutMenuScrollable>
      </styledEl.FlyoutMenuContents>
    </styledEl.FlyoutMenu>
  )

  return (
    <styledEl.SelectorWrapper ref={node} onClick={toggleModal}>
      <styledEl.SelectorControls ref={nodeSelector} $isChainIdUnsupported={isChainIdUnsupported} $isOpen={isOpen}>
        {!isChainIdUnsupported ? (
          <>
            <styledEl.SelectorLogo src={logoUrl} />
            <styledEl.SelectorLabel>{info?.label}</styledEl.SelectorLabel>
            <styledEl.StyledChevronDown $isOpen={isOpen} />
          </>
        ) : (
          <>
            <styledEl.NetworkIcon />
            <styledEl.NetworkAlertLabel>
              <Trans>Switch Network</Trans>
            </styledEl.NetworkAlertLabel>
            <styledEl.StyledChevronDown $isOpen={isOpen} />
          </>
        )}
      </styledEl.SelectorControls>
      {/* On mobile the flyout is a position:fixed bottom-sheet. It must be
          PORTALED to <body>: rendered inline it sits inside OphisHeader, whose
          backdrop-filter:blur creates a containing block for fixed descendants,
          so `bottom:56px` resolved against the ~83px header and the sheet
          rendered off-screen at the top (unselectable). On desktop the flyout
          is position:absolute relative to the selector, so it stays inline. */}
      {isOpen && (isUpToMedium ? createPortal(flyoutMenu, document.body) : flyoutMenu)}
    </styledEl.SelectorWrapper>
  )
}
