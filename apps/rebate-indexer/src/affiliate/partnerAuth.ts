import { recoverMessageAddress, isAddress, hashMessage, parseAbi } from 'viem';
import { getRpcClient } from '../rpc/client.js';
import { SUPPORTED_CHAIN_IDS } from '../cow/client.js';

const CONTRACT_SIGNATURE_ABI = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

// Signature-gated access for the Partner dashboard.
//
// The Partner dashboard is NOT public: it is visible only to whitelisted partner
// addresses (= the referrer_wallet of an ACTIVE partner-kind ref_code), and a
// wallet signature proves ownership so one partner can never read another's data.
//
// EOAs prove key ownership; contract wallets must approve the message on their
// operator-pinned authentication chain. Records are global by address, so letting
// callers pick any same-address deployment would admit stale/different Safe owners.
// The route separately applies its authorization and partner-whitelist checks.

/** Replay window: a signed access message is valid for this many seconds. */
export const PARTNER_SIG_MAX_AGE_SEC = 300;
/** Small allowance for client/server clock skew (seconds). */
const CLOCK_SKEW_SEC = 60;

/**
 * The exact message the wallet signs. Namespaced by the app + ACTION string so a
 * signature captured for one Ophis flow (e.g. dashboard access) cannot be replayed
 * for another (e.g. minting a code), and vice-versa. Address is lowercased for a
 * stable, case-insensitive comparison.
 */
export function buildSignedActionMessage(action: string, address: string, issuedSec: number, chainId?: number): string {
  return `Ophis ${action}\nAddress: ${address.toLowerCase()}\nIssued: ${issuedSec}${chainId === undefined ? '' : `\nChain ID: ${chainId}`}`;
}

/** Partner-dashboard access message (back-compat wrapper). */
export function buildPartnerAuthMessage(address: string, issuedSec: number): string {
  return buildSignedActionMessage('Partner Dashboard access', address, issuedSec);
}

export interface PartnerAuthInput {
  /** The action being authorized (namespaces the signature). Defaults to dashboard access. */
  readonly action?: string;
  /** The address the caller claims to be (and the dashboard they request). */
  readonly address: string;
  /** Unix seconds embedded in the signed message. */
  readonly issued: number;
  readonly signature: `0x${string}`;
  /** Required for contract wallets; must match their operator-pinned authority. */
  readonly chainId?: number;
  /** Server's current unix seconds (injected for testability). */
  readonly nowSec: number;
}

export type PartnerAuthResult =
  | { readonly ok: true; readonly address: `0x${string}` }
  | { readonly ok: false; readonly reason: string };

/**
 * Verifies a partner-dashboard access signature. On success returns the recovered
 * (lowercased) address, which the caller must then check against the partner
 * whitelist and the requested :wallet. Contract verification uses the pinned RPC.
 *
 * Rejects: malformed address, non-integer/future/expired timestamp, malformed
 * signature, and a signer that does not match the claimed address.
 */
export async function verifyPartnerAuth(
  input: PartnerAuthInput,
  clientForChain = getRpcClient,
): Promise<PartnerAuthResult> {
  const { address, issued, signature, nowSec } = input;

  if (typeof address !== 'string' || !isAddress(address)) {
    return { ok: false, reason: 'invalid address' };
  }
  if (!Number.isInteger(issued)) {
    return { ok: false, reason: 'invalid issued timestamp' };
  }
  // Reject timestamps in the future (beyond skew) — prevents pre-signing far-dated tokens.
  if (issued > nowSec + CLOCK_SKEW_SEC) {
    return { ok: false, reason: 'issued timestamp is in the future' };
  }
  // Reject stale signatures — bounds replay.
  if (issued < nowSec - PARTNER_SIG_MAX_AGE_SEC) {
    return { ok: false, reason: 'signature expired' };
  }
  if (typeof signature !== 'string' || signature.length > 16_386 || !/^0x(?:[0-9a-fA-F]{2})*$/.test(signature)) {
    return { ok: false, reason: 'invalid signature' };
  }

  if (input.chainId !== undefined && (!Number.isSafeInteger(input.chainId) || input.chainId <= 0)) {
    return { ok: false, reason: 'invalid signature chain' };
  }

  const message = buildSignedActionMessage(input.action ?? 'Partner Dashboard access', address, issued, input.chainId);
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    if (recovered.toLowerCase() === address.toLowerCase()) {
      return { ok: true, address: address.toLowerCase() as `0x${string}` };
    }
  } catch {
    // Safe signatures need contract verification, not EOA recovery.
  }

  if (input.chainId !== undefined) {
    // EOA ownership is chain-independent; only contract verification needs an available RPC.
    if (!SUPPORTED_CHAIN_IDS.includes(input.chainId)) return { ok: false, reason: 'unsupported signature chain' };
    try {
      const authChains: unknown = JSON.parse(process.env.CONTRACT_WALLET_AUTH_CHAINS || '{}');
      const authority = authChains && typeof authChains === 'object' && !Array.isArray(authChains)
        ? (authChains as Record<string, unknown>)[address.toLowerCase()]
        : undefined;
      if (!Number.isInteger(authority) || authority !== input.chainId) {
        return { ok: false, reason: 'contract wallet authentication chain is not configured or does not match' };
      }
      const client = clientForChain(input.chainId);
      if (await client.getChainId() !== input.chainId) return { ok: false, reason: 'signature RPC chain mismatch' };
      const result = await client.readContract({
        address: address as `0x${string}`, abi: CONTRACT_SIGNATURE_ABI,
        functionName: 'isValidSignature', args: [hashMessage(message), signature],
      });
      if (result === '0x1626ba7e') return { ok: true, address: address.toLowerCase() as `0x${string}` };
    } catch {
      return { ok: false, reason: 'contract signature verification failed' };
    }
  }
  return { ok: false, reason: 'signer does not match claimed address' };
}
