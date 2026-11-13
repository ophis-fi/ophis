import { ReactNode, RefObject, useState } from 'react'

import { getChainInfo } from '@cowprotocol/common-const'
import { TargetChainId } from '@cowprotocol/cow-sdk'

import { Trans, useLingui } from '@lingui/react/macro'

import { NetworksList } from 'common/pure/NetworksList/NetworksList.pure'

import * as styledEl from './NetworkSelector.styled'

interface NetworkSelectorMenuProps {
  menuRef: RefObject<HTMLDivElement | null>
  currentChainId: TargetChainId | null
  availableChains: TargetChainId[]
  isDarkMode: boolean
  onSelectChain(chainId: TargetChainId): void
  onClose(): void
}

export function NetworkSelectorMenu({
  menuRef,
  currentChainId,
  availableChains,
  isDarkMode,
  onSelectChain,
  onClose,
}: NetworkSelectorMenuProps): ReactNode {
  const { t } = useLingui()
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredChains = availableChains.filter(
    (id) => getChainInfo(id).label.toLowerCase().includes(normalizedQuery) || String(id).includes(normalizedQuery),
  )

  return (
    <styledEl.FlyoutMenu>
      <styledEl.FlyoutMenuContents
        ref={menuRef}
        aria-label={t`Select a network`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          onClose()
        }}
      >
        <styledEl.FlyoutHeader>
          <styledEl.FlyoutHeaderTitle>
            <Trans>Select a network</Trans>
          </styledEl.FlyoutHeaderTitle>
          <styledEl.CloseButton type="button" aria-label={t`Close`} onClick={onClose}>
            <styledEl.CloseIcon aria-hidden="true" />
          </styledEl.CloseButton>
        </styledEl.FlyoutHeader>
        <styledEl.NetworkSearch>
          <styledEl.NetworkSearchInput
            autoFocus
            aria-label={t`Search network`}
            placeholder={t`Search network`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </styledEl.NetworkSearch>
        <styledEl.FlyoutMenuScrollable>
          <styledEl.FlayoutMenuList>
            <NetworksList
              currentChainId={currentChainId}
              isDarkMode={isDarkMode}
              onSelectChain={onSelectChain}
              availableChains={filteredChains}
            />
            {filteredChains.length === 0 && (
              <p role="status">
                <Trans>No networks found.</Trans>
              </p>
            )}
          </styledEl.FlayoutMenuList>
        </styledEl.FlyoutMenuScrollable>
      </styledEl.FlyoutMenuContents>
    </styledEl.FlyoutMenu>
  )
}
