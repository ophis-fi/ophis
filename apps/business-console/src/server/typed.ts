// The typed data a wallet signs (EIP-712), shared by the server and the signing page. It imports nothing.
// Domain: no verifyingContract, because no contract verifies it. The binding to this app is in the message:
// site, organisationId and wallet. Milestone 4b adds its own struct next to Link; the verifier takes any of them.
export interface Typed {
  domain: { name: string; version: string; chainId: number }
  types: Record<string, { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}
export const LINK_ACTION = 'Link this wallet to this organisation'
export const CHAIN_NAME: Record<number, string> = { 1: 'Ethereum', 10: 'OP Mainnet', 8453: 'Base', 42161: 'Arbitrum One' }
/** Times are Unix seconds. */
export interface LinkFields { chainId: number; site: string; organisationId: string; wallet: string; nonce: string; issuedAt: number; expiresAt: number }
const field = (type: string) => (name: string) => ({ name, type })
export const typedLink = (f: LinkFields): Typed => ({
  domain: { name: 'Ophis Business', version: '1', chainId: f.chainId },
  types: {
    EIP712Domain: [field('string')('name'), field('string')('version'), field('uint256')('chainId')],
    Link: [...['action', 'site', 'organisationId'].map(field('string')), field('address')('wallet'), field('bytes32')('nonce'), ...['issuedAt', 'expiresAt'].map(field('uint64'))],
  },
  primaryType: 'Link',
  message: { action: LINK_ACTION, site: f.site, organisationId: f.organisationId, wallet: f.wallet, nonce: f.nonce, issuedAt: f.issuedAt, expiresAt: f.expiresAt },
})
