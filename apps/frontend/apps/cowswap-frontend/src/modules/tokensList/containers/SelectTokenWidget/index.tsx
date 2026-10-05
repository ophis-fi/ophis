import { useSetAtom } from 'jotai'
import { ReactNode, Suspense, useEffect, useContext } from 'react'

import { Loader } from '@cowprotocol/ui'

import { useChainPanelState, useViewWithFlows, useWidgetEffects, useWidgetOpenState } from './hooks'
import { InlineTokenPickerContext } from './inlineTokenPicker.context'
import { SelectTokenModal, SelectTokenModalFrame } from './internal'
import { customFlowsRegistryAtom } from './state'
import { CustomFlowsRegistry, TokenSelectorView } from './types'

import { useSelectTokenWidgetState } from '../../hooks/useSelectTokenWidgetState'
import * as styledEl from '../../pure/SelectTokenModal/styled'
import { updateSelectTokenWidgetAtom } from '../../state/selectTokenWidgetAtom'

export interface SelectTokenWidgetProps {
  displayLpTokenLists?: boolean
  standalone?: boolean
  /**
   * Custom flows registry - allows injecting pre/post flow views from outside.
   * This keeps the token selector domain-agnostic.
   *
   * @example
   * ```tsx
   * const customFlows: CustomFlowsRegistry = {
   *   [TokenSelectorView.ImportToken]: {
   *     preFlow: (context) => needsConsent
   *       ? <ConsentModal onConfirm={context.onDone} onCancel={context.onCancel} />
   *       : null
   *   }
   * }
   *
   * <SelectTokenWidget customFlows={customFlows} />
   * ```
   */
  customFlows?: CustomFlowsRegistry
}

/**
 * SelectTokenWidget - Token selector modal
 *
 * Uses slot-based composition with configurable custom flows.
 * Custom flows (like consent) are provided externally via the customFlows prop.
 */
export function SelectTokenWidget({ displayLpTokenLists, standalone, customFlows }: SelectTokenWidgetProps): ReactNode {
  useWidgetEffects(useWidgetOpenState())
  const updateWidgetState = useSetAtom(updateSelectTokenWidgetAtom)
  const setCustomFlows = useSetAtom(customFlowsRegistryAtom)

  // Sync config props to atoms
  useEffect(() => {
    updateWidgetState({ displayLpTokenLists, standalone })
  }, [displayLpTokenLists, standalone, updateWidgetState])

  // Sync custom flows to atom
  useEffect(() => {
    setCustomFlows(customFlows ?? {})
  }, [customFlows, setCustomFlows])

  return (
    <Suspense
      fallback={
        <SelectTokenModalFrame>
          <SelectTokenModal.Header />
          <Loader />
        </SelectTokenModalFrame>
      }
    >
      <SelectTokenModal>
        <SelectTokenWidgetContent />
      </SelectTokenModal>
    </Suspense>
  )
}

function SelectTokenWidgetContent(): ReactNode {
  const inline = useContext(InlineTokenPickerContext)
  const flowResult = useViewWithFlows()
  const { tradeType, field } = useSelectTokenWidgetState()
  const { isEnabled: isChainPanelEnabled } = useChainPanelState(tradeType, field)

  // Generic flow content checks - applies to ALL views
  // If there's pre-flow content, render it instead of the base view
  if (flowResult.preFlowResult?.content) {
    return flowResult.preFlowResult.content
  }

  // If there's post-flow content, render it instead of the base view
  if (flowResult.postFlowResult?.content) {
    return flowResult.postFlowResult.content
  }

  // Render the base view with optional flow data

  switch (flowResult.baseView) {
    case TokenSelectorView.ImportToken:
      return <SelectTokenModal.ImportToken flowData={flowResult.preFlowResult?.data} />
    case TokenSelectorView.ImportList:
      return <SelectTokenModal.ImportList />
    case TokenSelectorView.Manage:
      return <SelectTokenModal.Manage />
    case TokenSelectorView.LpToken:
      return <SelectTokenModal.LpToken />
    default:
      // Main token list view
      return (
        <>
          <styledEl.Wrapper $hasChainPanel={isChainPanelEnabled && !inline}>
            <SelectTokenModal.Header />
            <SelectTokenModal.Search />
            <SelectTokenModal.ChainSelector />
            <styledEl.Body className={inline ? 'swp-inline-token-body' : undefined}>
              <styledEl.TokenColumn>
                <SelectTokenModal.TokenList />
              </styledEl.TokenColumn>
            </styledEl.Body>
          </styledEl.Wrapper>
          <SelectTokenModal.DesktopChainPanel />
        </>
      )
  }
}

// re-export for external use
export { SelectTokenModal }
