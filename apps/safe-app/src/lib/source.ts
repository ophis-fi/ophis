// Safe (app.safe.global) appends ?utm_source=SafeWallet when it launches the app in its iframe,
// so a Safe App can attribute Safe-sourced sessions. We READ it (it survives the iframe launch as
// a normal query param, alongside ?ref=) and surface it in the UI. Note: this is analytics/source
// attribution only — it does NOT affect the rebate, which rides on the appData referral code
// (ophisReferrer.code, see referral.ts). Kept separate so wiring a real analytics sink later is a
// one-line change.
export function getLaunchSource(): string | undefined {
  return new URLSearchParams(location.search).get('utm_source') ?? undefined;
}

/** True when the app was launched from inside the Safe{Wallet} interface (?utm_source=SafeWallet). */
export function isSafeWalletLaunch(): boolean {
  return getLaunchSource()?.toLowerCase() === 'safewallet';
}
