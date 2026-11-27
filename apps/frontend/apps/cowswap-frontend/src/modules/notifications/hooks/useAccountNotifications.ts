import type { NotificationModel } from '@cowprotocol/core'

const FORCED_SPEECH_BUBBLE_NOTIFICATION: NotificationModel = {
  id: -999_999,
  account: 'debug',
  title: 'Debug speech bubble notification',
  description:
    'This message is forced in development mode. Set REACT_APP_FORCE_SPEECH_BUBBLE_NOTIFICATION=false to disable.',
  createdAt: '2099-01-01T00:00:00.000Z',
  url: '/#/swap',
  thumbnail: null,
  location: 'speechBubble',
}

// Ophis has no account campaign feed. The upstream CMS publishes CoW promotions.
const accountNotifications: NotificationModel[] =
  process.env.NODE_ENV === 'development' && process.env.REACT_APP_FORCE_SPEECH_BUBBLE_NOTIFICATION === 'true'
    ? [FORCED_SPEECH_BUBBLE_NOTIFICATION]
    : []

export function useAccountNotifications(): NotificationModel[] {
  return accountNotifications
}
