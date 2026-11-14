// The typed data a wallet signs (EIP-712), shared by the server and the signing page. It imports nothing.
// Domain: no verifyingContract, because no contract verifies it. The binding to this app is in the message:
// site, organisationId and wallet. Two structs, one verifier: Link (a wallet joins an organisation) and Proof (the
// recovery wallet replaces the Owner passkeys, or cancels that).
export interface Typed {
  domain: { name: string; version: string; chainId: number }
  types: Record<string, { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}
export const LINK_ACTION = 'Link this wallet to this organisation'
export const CHAIN_NAME: Record<number, string> = { 1: 'Ethereum', 10: 'OP Mainnet', 100: 'Gnosis', 130: 'Unichain', 8453: 'Base', 42161: 'Arbitrum One' }
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

// Last-Owner recovery (recovery.md sections 4 and 5). Three fixed sentences; the server picks one, never the caller.
export const PROOF_ACTION = {
  replace: 'Replace all Owner passkeys of this organisation',
  override: 'Replace all Owner passkeys of this organisation, overriding its Owners',
  cancel: 'Cancel account recovery',
  // Milestone 5: the recovery wallet a new organisation names confirms the first Owner's passkey (recovery.md section 3).
  activate: 'Activate this organisation and confirm its first Owner passkey',
} as const
export type ProofKind = keyof typeof PROOF_ACTION
/** credentialHash: SHA-256(credential id, public key) of the passkey the proof is for. A cancel names no passkey: 32 zero bytes. */
export interface ProofFields extends LinkFields { kind: ProofKind; credentialHash: string }
export const typedProof = (f: ProofFields): Typed => ({
  domain: { name: 'Ophis Business', version: '1', chainId: f.chainId },
  types: {
    EIP712Domain: [field('string')('name'), field('string')('version'), field('uint256')('chainId')],
    Proof: [...['action', 'site', 'organisationId'].map(field('string')), field('address')('wallet'), field('bytes32')('credentialHash'), field('bytes32')('nonce'), ...['issuedAt', 'expiresAt'].map(field('uint64'))],
  },
  primaryType: 'Proof',
  message: { action: PROOF_ACTION[f.kind], site: f.site, organisationId: f.organisationId, wallet: f.wallet, credentialHash: f.credentialHash, nonce: f.nonce, issuedAt: f.issuedAt, expiresAt: f.expiresAt },
})
