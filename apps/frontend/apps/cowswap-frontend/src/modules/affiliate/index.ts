export { affiliateTraderSavedCodeAtom } from './state/affiliateTraderSavedCodeAtom'
export { useTradeRewardPromotion } from './hooks/useTradeRewardPromotion'
export { affiliateOwnCodeAtom, setAffiliateOwnCodeAtom } from './state/affiliateOwnCodeAtom'

// Ophis native affiliate program (rebates.ophis.fi). NATIVE-only surfaces:
// the app-wide ?ref capture + bind updater, plus the typed API client and
// signing hook consumed by the /affiliate and /partner pages.
export { RefCodeCaptureUpdater } from './updaters/RefCodeCaptureUpdater'
export { useOphisAffiliateSign } from './hooks/useOphisAffiliateSign'
// Profile referral code creation, share link, and attribution totals.
export { OphisAffiliateDashboard } from './containers/OphisAffiliateDashboard'
export {
  AffiliateApiError,
  REBATES_API,
  bindRefCode,
  createRefCode,
  claimTradeReward,
  getAffiliateStats,
  getLeaderboard,
  getPartnerDashboard,
  getTradeRewardStatus,
  getWalletXp,
  lookupRefCode,
  submitRewardClaim,
} from './lib/ophisAffiliateApi'
export type {
  AffiliateKind,
  AffiliateSignedAction,
  AffiliateStats,
  LeaderboardEntry,
  LeaderboardResponse,
  PartnerDashboard,
  PartnerReferee,
  RefBindRequestBody,
  RefBindResponse,
  RefCodeCreateResponse,
  RefLookupResponse,
  RewardClaimRequestBody,
  RewardClaimResponse,
  SponsoredTradeRewardClaim,
  SignedRequestBody,
  WalletXp,
  TradeRewardStatus,
} from './lib/ophisAffiliateApi'
