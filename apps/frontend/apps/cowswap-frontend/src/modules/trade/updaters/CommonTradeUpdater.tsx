import { useSetupTradeState } from '../hooks/setupTradeState/useSetupTradeState'
import { useNotifyWidgetTrade } from '../hooks/useNotifyWidgetTrade'
import { useSetupTradeTypeInfo } from '../hooks/useSetupTradeTypeInfo'

export function CommonTradeUpdater({
  disableTradeNotifications = false,
}: {
  disableTradeNotifications?: boolean
}): null {
  useSetupTradeState()
  useNotifyWidgetTrade(disableTradeNotifications)
  useSetupTradeTypeInfo()

  return null
}
