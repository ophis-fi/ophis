import { useCallback } from 'react'

import { useActiveBlockingView } from './useActiveBlockingView'
import { useManageWidgetVisibility } from './useManageWidgetVisibility'
import { usePoolPageHandlers } from './usePoolPageHandlers'
import { useResetListImport } from './useResetListImport'
import { useResetTokenImport } from './useResetTokenImport'

import { useSelectTokenWidgetState } from '../../../hooks/useSelectTokenWidgetState'
import { useUpdateSelectTokenWidgetState } from '../../../hooks/useUpdateSelectTokenWidgetState'
import { TokenSelectorView } from '../types'

/** Escape follows the current view's Back/Cancel action, without importing or consenting. */
export function useInlineTokenPickerBack(onDismiss: () => void): () => void {
  const view = useActiveBlockingView()
  const { listToToggle } = useSelectTokenWidgetState()
  const updateWidget = useUpdateSelectTokenWidgetState()
  const { closeManageWidget } = useManageWidgetVisibility()
  const resetTokenImport = useResetTokenImport()
  const resetListImport = useResetListImport()
  const { closePoolPage } = usePoolPageHandlers(updateWidget)

  return useCallback(() => {
    if (listToToggle) {
      updateWidget({ listToToggle: undefined })
      return
    }
    switch (view) {
      case TokenSelectorView.ImportToken:
        return resetTokenImport()
      case TokenSelectorView.ImportList:
        return resetListImport()
      case TokenSelectorView.Manage:
        return closeManageWidget()
      case TokenSelectorView.LpToken:
        return closePoolPage()
      default:
        return onDismiss()
    }
  }, [view, listToToggle, updateWidget, resetTokenImport, resetListImport, closeManageWidget, closePoolPage, onDismiss])
}
