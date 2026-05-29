import { ReactNode, useRef, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'

import { getChainInfo } from '@cowprotocol/common-const'
import { useAvailableChains, useBodyScrollbarLocker, useMediaQuery, useOnClickOutside } from '@cowprotocol/common-hooks'
import { AdditionalTargetChainId } from '@cowprotocol/cow-sdk'
import { Media } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Trans, useLingui } from '@lingui/react/macro'

import { useModalIsOpen, useToggleModal } from 'legacy/state/application/hooks'
import { ApplicationModal } from 'legacy/state/application/reducer'
import { useIsDarkMode } from 'legacy/state/user/hooks'

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
  const isDarkMode = useIsDarkMode()
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

          {/* Ophis bridge destinations (2026-05-22). Solana + Bitcoin
              are NEAR-Intents bridge destinations only — no wallet
              connect possible. Surfacing here for discoverability;
              actual selection happens in the buy-side token picker. */}
          <BridgeDestinationsFooter onClose={isOpen ? toggleModal : undefined} />
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

/**
 * Footer section in the network-selector dropdown that lists Solana +
 * Bitcoin as NEAR-Intents bridge destinations. Pure visual + nav — does
 * not call `eth_switchNetwork` (Solana/Bitcoin aren't EVM, no wallet
 * adapter). Clicking a row deep-links to the swap form so the user can
 * pick a buy-side token on that chain.
 *
 * `onClose` is invoked on click so the network-selector dropdown closes
 * during the SPA navigation (Codex audit 2026-05-23 — previously the
 * dropdown stayed open after route change because Link doesn't trigger
 * the click-outside handler).
 */
function BridgeDestinationsFooter({ onClose }: { onClose?: () => void }): ReactNode {
  const isDarkMode = useIsDarkMode()
  const bridgeChainIds = [AdditionalTargetChainId.SOLANA, AdditionalTargetChainId.BITCOIN] as const

  return (
    <styledEl.BridgeDestinationsSection>
      <styledEl.BridgeDestinationsHeader>
        <span>Cross-chain destinations</span>
        <styledEl.BridgeDestinationsBadge>via NEAR Intents</styledEl.BridgeDestinationsBadge>
      </styledEl.BridgeDestinationsHeader>
      <styledEl.BridgeDestinationsList>
        {bridgeChainIds.map((id) => {
          const info = getChainInfo(id)
          const logoUrl = isDarkMode ? info.logo.dark : info.logo.light
          return (
            <styledEl.BridgeDestinationRow key={id} to="/1/swap/_/_" rel="nofollow" onClick={onClose}>
              <img src={logoUrl} alt="" />
              <span>{info.label}</span>
              <span className="chevron" aria-hidden="true">→</span>
            </styledEl.BridgeDestinationRow>
          )
        })}
      </styledEl.BridgeDestinationsList>
      <styledEl.BridgeDestinationHint>
        Destination-only. Select in the token picker after opening a trade.
      </styledEl.BridgeDestinationHint>
    </styledEl.BridgeDestinationsSection>
  )
}
