// Ophis divergence: default widget host points at the Ophis app, not swap.cow.fi.
// sanitizeWidgetBaseUrl() falls back to this constant whenever `baseUrl` is
// omitted/blank/invalid, so a bare-default embed loads the Ophis swap surface
// (and routes through the Ophis solver + partner fee). The export name is kept
// as COWSWAP_ORIGIN to stay subtree-merge-friendly with upstream cowprotocol.
// See apps/frontend/.ophis-divergences.md.
export const COWSWAP_ORIGIN = 'https://swap.ophis.fi'
