import { ARC_ENABLED } from '@cowprotocol/common-const'

export const CCTP_ENABLED = ARC_ENABLED && process.env.REACT_APP_CCTP_ENABLED === 'true'

export const ordersTableFeatures = {
  // Temporary hide estimated execution price because it requires rework and retest
  DISPLAY_EST_EXECUTION_PRICE: false,
  DISPLAY_EXECUTION_TIME: false,
}
