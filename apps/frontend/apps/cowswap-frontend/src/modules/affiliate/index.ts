export { affiliateTraderSavedCodeAtom } from './state/affiliateTraderSavedCodeAtom'
export { affiliateOwnCodeAtom, setAffiliateOwnCodeAtom } from './state/affiliateOwnCodeAtom'

// Ophis native affiliate program (rebates.ophis.fi). NATIVE-only surfaces:
// the app-wide ?ref capture + bind updater, plus the typed API client and
// signing hook consumed by the /affiliate and /partner pages.
export { RefCodeCaptureUpdater } from './updaters/RefCodeCaptureUpdater'
export { useOphisAffiliateSign } from './hooks/useOphisAffiliateSign'
// Folded into the Profile page (Phase C restructure, 2026-06-11). PUBLIC
// regular-8% affiliate dashboard body (mint code + share link + referred
// totals). No partner-tier surface here.
export { OphisAffiliateDashboard } from './containers/OphisAffiliateDashboard'
export {
  AffiliateApiError,
  REBATES_API,
  bindRefCode,
  createRefCode,
  getAffiliateStats,
  getLeaderboard,
  getPartnerDashboard,
  getRankStatus,
  getWalletXp,
  lookupRefCode,
} from './lib/ophisAffiliateApi'
export type {
  AffiliateKind,
  AffiliateSignedAction,
  AffiliateStats,
  LeaderboardEntry,
  LeaderboardResponse,
  PartnerDashboard,
  PartnerReferee,
  RankStatus,
  RefBindRequestBody,
  RefBindResponse,
  RefCodeCreateResponse,
  RefLookupResponse,
  SignedRequestBody,
  WalletXp,
} from './lib/ophisAffiliateApi'
