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
export const CHAIN_NAME: Record<number, string> = { 1: 'Ethereum', 10: 'OP Mainnet', 100: 'Gnosis', 130: 'Unichain', 8453: 'Base', 42161: 'Arbitrum One', 4663: 'Robinhood Chain', 5042: 'Arc' }
// What a wallet that does not know a chain needs to add it (wallet_addEthereumChain, after error 4902 on a switch): the
// chains most wallets lack (owner, 2026-11-19). The RPC is the first endpoint of passkeys.ts; tests/worker.test.ts compares.
export const NETWORKS: Record<number, { chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] }> = {
  4663: { chainName: CHAIN_NAME[4663], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] },
  5042: { chainName: CHAIN_NAME[5042], nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.arc.io'], blockExplorerUrls: ['https://explorer.arc.io'] },
}
/** The signing page's wallet moves to the chain; one that does not know it (4902, which some wallets nest) is asked to add
 *  it first, from NETWORKS. Here, with no DOM, so that tests/worker.test.ts runs it against a stand-in wallet. */
export async function switchTo(wallet: { request(call: { method: string; params?: unknown[] }): Promise<unknown> }, chainId: number) {
  const hex = `0x${chainId.toString(16)}`
  try {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  } catch (error) {
    const e = error as { code?: number; data?: { originalError?: { code?: number } } } | null
    if ((e?.code !== 4902 && e?.data?.originalError?.code !== 4902) || !NETWORKS[chainId]) throw error
    await wallet.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, ...NETWORKS[chainId] }] })
    // Adding need not switch (EIP-3085): switch again, so that nothing after runs on the old chain (review, PR #1674).
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  }
}
/** The sanctions lists the operator loads (onboarding.ts), by code, with the names the pages show. */
export const LISTS: Record<string, string> = { eu: 'EU consolidated financial sanctions list', un: 'UN Security Council consolidated list', ofac: 'OFAC SDN list' }
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
