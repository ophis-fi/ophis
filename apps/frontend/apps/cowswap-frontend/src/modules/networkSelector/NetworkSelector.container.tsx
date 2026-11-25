import { ReactNode, useRef } from 'react'

import { getChainInfo } from '@cowprotocol/common-const'
import { useAvailableChains, useBodyScrollbarLocker, useMediaQuery, useOnClickOutside } from '@cowprotocol/common-hooks'
import { isSupportedChainId } from '@cowprotocol/common-utils'
import { TargetChainId } from '@cowprotocol/cow-sdk'
import { Media } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Trans } from '@lingui/react/macro'
import { OPHIS_SOLANA_CONFIG } from 'entities/solana'
import { createPortal } from 'react-dom'
import { useTheme } from 'styled-components/macro'

import { useModalIsOpen, useToggleModal } from 'legacy/state/application/hooks'
import { ApplicationModal } from 'legacy/state/application/reducer'

import { useIsProviderNetworkUnsupported } from 'common/hooks/useIsProviderNetworkUnsupported'
import { useNavigate } from 'common/hooks/useNavigate'
import { useOnSelectNetwork } from 'common/hooks/useOnSelectNetwork'
import { useShouldHideNetworkSelector } from 'common/hooks/useShouldHideNetworkSelector'

import * as styledEl from './NetworkSelector.styled'
import { NetworkSelectorMenu } from './NetworkSelectorMenu.pure'

interface NetworkSelectorProps {
  selectedChainId?: TargetChainId
  additionalChainIds?: TargetChainId[]
  onSelectChain?(chainId: TargetChainId): boolean
  disabled?: boolean
  tokenPickerTrigger?: boolean
  nativeSolanaSelected?: boolean
  includeNativeSolana?: boolean
}

function useDisplayedNetwork(
  selectedChainId: TargetChainId | undefined,
  nativeSolanaSelected: boolean,
): {
  unsupported: boolean
  currentChainId: TargetChainId | null
  isDarkMode: boolean
  logo: string
  label: string
} {
  const { chainId: walletChainId } = useWalletInfo()
  const chainId = selectedChainId ?? walletChainId
  const info = getChainInfo(chainId)
  const { darkMode: isDarkMode } = useTheme()
  const walletUnsupported = useIsProviderNetworkUnsupported()
  const unsupported = !nativeSolanaSelected && selectedChainId === undefined && walletUnsupported
  const currentChainId = nativeSolanaSelected || unsupported ? null : chainId
  if (nativeSolanaSelected)
    return { unsupported, currentChainId, isDarkMode, logo: '/logos/token-sol.svg', label: 'Solana' }
  return {
    unsupported,
    currentChainId,
    isDarkMode,
    logo: isDarkMode ? info.logo.dark : info.logo.light,
    label: info.label,
  }
}

export function NetworkSelector({
  selectedChainId,
  additionalChainIds = [],
  onSelectChain: selectSourceChain,
  disabled = false,
  tokenPickerTrigger = false,
  nativeSolanaSelected = false,
  includeNativeSolana = !selectSourceChain && !tokenPickerTrigger,
}: NetworkSelectorProps = {}): ReactNode {
  const navigate = useNavigate()
  const display = useDisplayedNetwork(selectedChainId, nativeSolanaSelected)
  const node = useRef<HTMLDivElement>(null)
  const nodeMobile = useRef<HTMLDivElement>(null)
  const nodeSelector = useRef<HTMLButtonElement>(null)
  const isOpen = useModalIsOpen(ApplicationModal.NETWORK_SELECTOR)
  const toggleModal = useToggleModal(ApplicationModal.NETWORK_SELECTOR)
  const isUpToMedium = useMediaQuery(Media.upToMedium(false))
  const shouldHideNetworkSelector = useShouldHideNetworkSelector()
  useOnClickOutside(isUpToMedium ? [nodeMobile, nodeSelector] : [node], () => {
    if (isOpen) {
      toggleModal()
    }
  })

  useBodyScrollbarLocker(isOpen && !disabled && !shouldHideNetworkSelector, Media.upToMedium(false))

  const onSelectChain = useOnSelectNetwork()
  const availableChains = useAvailableChains()
  const handleClose = (): void => {
    if (isOpen) toggleModal()
    nodeSelector.current?.focus()
  }
  const handleSelectChain = (targetChainId: TargetChainId): void => {
    if (disabled) return
    if (isOpen) toggleModal()
    if (selectSourceChain?.(targetChainId)) return
    if (isSupportedChainId(targetChainId)) {
      const returnToSwap = nativeSolanaSelected ? () => navigate(`/${targetChainId}/swap`) : undefined
      void onSelectChain(targetChainId, true, returnToSwap)
    }
  }

  if (shouldHideNetworkSelector) {
    return null
  }

  const flyoutMenu = (
    <NetworkSelectorMenu
      menuRef={nodeMobile}
      currentChainId={display.currentChainId}
      availableChains={[...new Set([...availableChains, ...additionalChainIds])]}
      isDarkMode={display.isDarkMode}
      onSelectChain={handleSelectChain}
      onClose={handleClose}
      nativeSolanaEnabled={!!OPHIS_SOLANA_CONFIG && includeNativeSolana}
    />
  )

  return (
    <styledEl.SelectorWrapper ref={node}>
      <styledEl.SelectorControls
        ref={nodeSelector}
        type="button"
        onClick={toggleModal}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        data-token-picker-trigger={tokenPickerTrigger || undefined}
        $isChainIdUnsupported={display.unsupported}
        $isOpen={isOpen}
      >
        {!display.unsupported ? (
          <>
            <styledEl.SelectorLogo src={display.logo} />
            <styledEl.SelectorLabel>{display.label}</styledEl.SelectorLabel>
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
      {isOpen && !disabled && (isUpToMedium ? createPortal(flyoutMenu, document.body) : flyoutMenu)}
    </styledEl.SelectorWrapper>
  )
}
