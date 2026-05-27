// Ophis Bungee affiliate ID, injected at build via the GitHub Actions secret
// REACT_APP_BUNGEE_AFFILIATE_ID (see .github/workflows/cloudflare-deploy.yml).
// Sent as the `affiliate` header on Bungee bridge quotes so the affiliate
// rev-share accrues to the Ophis Safe instead of the upstream CoW integrator.
// Undefined when unset, in which case no affiliate header is sent (the fee is
// never routed to a third party by default).
export const bungeeAffiliateCode = process.env.REACT_APP_BUNGEE_AFFILIATE_ID
