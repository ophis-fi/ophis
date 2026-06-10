export { AffiliatePartnerCodeCreation } from './containers/AffiliatePartnerCodeCreation'
export { AffiliatePartnerCodeInfo } from './containers/AffiliatePartnerCodeInfo'
export { AffiliatePartnerNextPayout } from './containers/AffiliatePartnerNextPayout'
export { AffiliatePartnerOnboard } from './containers/AffiliatePartnerOnboard'
export { AffiliatePartnerStats } from './containers/AffiliatePartnerStats'
export { AffiliateTraderCodeInfo } from './containers/AffiliateTraderCodeInfo'
export { AffiliateTraderExpiryBanner } from './containers/AffiliateTraderExpiryBanner'
export { AffiliateTraderHeaderButton } from './containers/AffiliateTraderHeaderButton.container'
export { AffiliateTraderModal } from './containers/AffiliateTraderModal'
export { AffiliateTraderNextPayout } from './containers/AffiliateTraderNextPayout'
export { AffiliateTraderOnboard } from './containers/AffiliateTraderOnboard'
export { AffiliateTraderRewardsRow } from './containers/AffiliateTraderRewardsRow'
export { AffiliateTraderStats } from './containers/AffiliateTraderStats'

export { useAffiliatePartnerInfo } from './hooks/useAffiliatePartnerInfo'
export { useIsRefCodeExpired } from './hooks/useIsRefCodeExpired'
export { useShouldShowAffiliateTraderHeaderButton } from './hooks/useShouldShowAffiliateTraderHeaderButton'
export { useAffiliateTraderWallet, TraderWalletStatus } from './hooks/useAffiliateTraderWallet'
export { useIsRewardsRowEnabled } from './hooks/useIsRewardsRowEnabled'

export { isSupportedPayoutsNetwork } from './lib/affiliateProgramUtils'

export { AffiliateTermsFaqLinks, ColumnOneCard, ThreeColumnGrid, PageWrapper } from './pure/shared'
export { AffiliateTraderIneligible } from './pure/AffiliateTrader/AffiliateTraderIneligible'
export { AffiliateTraderLoading } from './pure/AffiliateTrader/AffiliateTraderLoading'
export { AffiliateTraderUnsupportedNetwork } from './pure/AffiliateTrader/AffiliateTraderUnsupportedNetwork'
export { UnsupportedNetwork } from './pure/UnsupportedNetwork'

export { affiliateTraderSavedCodeAtom } from './state/affiliateTraderSavedCodeAtom'

export { REF_CODE_MIN_LENGTH } from './config/affiliateProgram.const'

// Ophis native affiliate program (rebates.ophis.fi). NATIVE-only surfaces:
// the app-wide ?ref capture + bind updater, plus the typed API client and
// signing hook consumed by the /affiliate and /partner pages.
export { RefCodeCaptureUpdater } from './updaters/RefCodeCaptureUpdater'
export { useOphisAffiliateSign } from './hooks/useOphisAffiliateSign'
export {
  AffiliateApiError,
  REBATES_API,
  bindRefCode,
  createRefCode,
  getAffiliateStats,
  getPartnerDashboard,
  lookupRefCode,
} from './lib/ophisAffiliateApi'
export type {
  AffiliateKind,
  AffiliateSignedAction,
  AffiliateStats,
  PartnerDashboard,
  PartnerReferee,
  RefBindResponse,
  RefCodeCreateResponse,
  RefLookupResponse,
  SignedRequestBody,
} from './lib/ophisAffiliateApi'
