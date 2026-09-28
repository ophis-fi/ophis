import { normalizeOphisReferralCode } from '@ophis/sdk';

// The referral code carried in appData.metadata.ophisReferrer.code is what the rebate
// indexer attributes the 8-12% rev-share against. Accept it from ?ref= or the build-time env.
export function resolveReferralCode(chainId: number): string | undefined {
  const fromUrl = new URLSearchParams(location.search).get('ref');
  // Arc has no reward indexing. Skip the app default there; an explicit URL
  // code still reaches the SDK's informative rejection instead of disappearing.
  const raw = fromUrl ?? (chainId === 5042 ? undefined : import.meta.env.VITE_OPHIS_REFERRAL_CODE);
  if (!raw) return undefined;
  try {
    return normalizeOphisReferralCode(raw); // throws on bad grammar
  } catch (e) {
    console.warn('[ophis] invalid referral code, ignoring:', (e as Error).message);
    return undefined;
  }
}
