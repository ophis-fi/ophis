// The sample-price workbench stays local. The real swap fields use Ophis trade
// state in every environment; production builds eliminate only this demo route.
export const ASSET_SWAP_PREVIEW =
  process.env.NODE_ENV === 'development' && process.env.REACT_APP_ASSET_SWAP_PREVIEW === 'true'
