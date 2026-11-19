// The logos of the desk's chains and assets (owner, 2026-11-19), copied from the swap frontend (apps/frontend) and, for
// EURe, from cowprotocol/token-lists. The build emits them as files of this origin: the page's policy is img-src 'self'.
// An asset with no logo here (EURCV) shows its first letter.
import ethereum from './logos/chain-1.png'
import optimism from './logos/chain-10.png'
import robinhood from './logos/chain-4663.svg'
import arc from './logos/chain-5042.svg'
import base from './logos/chain-8453.png'
import arbitrum from './logos/chain-42161.jpg'
import eurc from './logos/token-eurc.png'
import eure from './logos/token-eure.png'
import usdc from './logos/token-usdc.png'
import usdg from './logos/token-usdg.svg'
import weth from './logos/token-weth.png'

export const CHAIN_LOGO: Record<number, string> = { 1: ethereum, 10: optimism, 4663: robinhood, 5042: arc, 8453: base, 42161: arbitrum }
export const ASSET_LOGO: Record<string, string> = { WETH: weth, USDC: usdc, USDG: usdg, EURC: eurc, EURe: eure }
