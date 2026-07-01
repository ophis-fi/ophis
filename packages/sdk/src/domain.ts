import { assertValidChainId } from './guards.js';

/**
 * EIP-712 verifying contract (GPv2Settlement) per chain, for building the CoW
 * order signing domain. Mirrors the authoritative frontend map
 * `COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS` in
 * apps/frontend/libs/common-utils/src/cowProtocolContracts.ts — keep in sync.
 *
 * CRITICAL: the Ophis-operated chains do NOT use CoW's canonical settlement.
 * Ophis self-deployed its own GPv2Settlement on those chains, so signing with
 * the canonical `0x9008…ab41` yields a domain separator the deployed contract
 * rejects — every order fails signature validation. cow-sdk only knows the
 * canonical address, so resolve the verifying contract through
 * getOphisSettlementAddress / getOphisOrderDomain, never the SDK default.
 *
 * Includes the Ophis-operated chains whose orderbook is currently paused
 * (MegaETH 4326, HyperEVM 999): the settlement contracts ARE deployed there,
 * so the map mirrors cowProtocolContracts.ts even though getOphisOrderbookUrl
 * omits them (no live orderbook host yet). Values are the PROD deployment;
 * barn/staging uses different contracts on migrated networks (out of scope).
 */

/** CoW Protocol's canonical GPv2Settlement (CREATE2-deterministic across official CoW chains). */
const CANONICAL_COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const;

/** Ophis-deployed GPv2Settlement on Optimism (10) + MegaETH (4326) — same deterministic address. */
const OPHIS_SETTLEMENT = '0x310784c7FCE12d578dA6f53460777bAc9718B859' as const;

/** Ophis-deployed GPv2Settlement on HyperEVM (999). */
const OPHIS_HYPEREVM_SETTLEMENT = '0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce' as const;

/** Ophis-deployed GPv2Settlement on Unichain (130). Verified on-chain (has code). */
const OPHIS_UNICHAIN_SETTLEMENT = '0x108A678716e5E1776036eF044CAB7064226F714E' as const;

export const OPHIS_SETTLEMENT_ADDRESSES: Readonly<Partial<Record<number, `0x${string}`>>> = Object.freeze({
  1: CANONICAL_COW_SETTLEMENT,
  100: CANONICAL_COW_SETTLEMENT,
  42161: CANONICAL_COW_SETTLEMENT,
  8453: CANONICAL_COW_SETTLEMENT,
  137: CANONICAL_COW_SETTLEMENT,
  43114: CANONICAL_COW_SETTLEMENT,
  56: CANONICAL_COW_SETTLEMENT,
  59144: CANONICAL_COW_SETTLEMENT,
  9745: CANONICAL_COW_SETTLEMENT,
  57073: CANONICAL_COW_SETTLEMENT,
  11155111: CANONICAL_COW_SETTLEMENT,
  10: OPHIS_SETTLEMENT, // Optimism — Ophis self-hosted settlement (verified on-chain)
  130: OPHIS_UNICHAIN_SETTLEMENT, // Unichain — Ophis self-hosted settlement (verified on-chain)
  4326: OPHIS_SETTLEMENT, // MegaETH — same deterministic Ophis settlement (orderbook paused)
  999: OPHIS_HYPEREVM_SETTLEMENT, // HyperEVM — Ophis settlement (orderbook paused)
});

/**
 * Returns the GPv2Settlement address (EIP-712 verifying contract) for a chain.
 * Throws on an invalid or unsupported chainId.
 */
export const getOphisSettlementAddress = (chainId: number): `0x${string}` => {
  assertValidChainId(chainId);
  const address = OPHIS_SETTLEMENT_ADDRESSES[chainId];
  if (!address) {
    throw new Error(
      `Ophis: no settlement address for chainId ${chainId}. Supported: ${Object.keys(OPHIS_SETTLEMENT_ADDRESSES).join(', ')}.`,
    );
  }
  return address;
};

/** The EIP-712 domain for signing a CoW order (cow-sdk `GPv2Order` typed data). */
export interface OphisOrderDomain {
  readonly name: 'Gnosis Protocol';
  readonly version: 'v2';
  readonly chainId: number;
  readonly verifyingContract: `0x${string}`;
}

/**
 * Builds the EIP-712 domain for signing a CoW order on a given chain, with the
 * correct per-chain verifying contract. Use this instead of hardcoding a
 * settlement address: hardcoding the canonical `0x9008…ab41` is wrong on the
 * Ophis-operated chains and produces signatures the deployed settlement rejects.
 *
 * @example
 *   const domain = getOphisOrderDomain(10);
 *   const signature = await wallet.signTypedData({ domain, types, primaryType: 'Order', message: order });
 */
export const getOphisOrderDomain = (chainId: number): OphisOrderDomain => ({
  name: 'Gnosis Protocol',
  version: 'v2',
  chainId,
  verifyingContract: getOphisSettlementAddress(chainId),
});

/**
 * GPv2VaultRelayer per chain: the contract a seller must `approve` their sell
 * token to (it pulls the token at settlement). Mirrors the authoritative frontend
 * map `COW_PROTOCOL_VAULT_RELAYER_ADDRESS` in
 * apps/frontend/libs/common-utils/src/cowProtocolContracts.ts — keep in sync.
 *
 * CRITICAL: the Ophis-operated chains do NOT use CoW's canonical relayer. They run
 * their own settlement + relayer, so on those chains approving the canonical
 * `0xC92E8bdf…` relayer leaves the order unfillable (the deployed Ophis settlement
 * pulls from the Ophis relayer, which never received the approval). cow-sdk only
 * knows the canonical address, so resolve the relayer through getOphisVaultRelayer,
 * never the cow-sdk default.
 */

/** CoW Protocol's canonical GPv2VaultRelayer (CREATE2-deterministic across official CoW chains). */
const CANONICAL_COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as const;

/** Ophis-deployed GPv2VaultRelayer on Optimism (10) + MegaETH (4326) — same deterministic address. */
const OPHIS_VAULT_RELAYER = '0x83847EaB41ad9ea43809ce71569eB2e9daF51830' as const;

/** Ophis-deployed GPv2VaultRelayer on HyperEVM (999). */
const OPHIS_HYPEREVM_VAULT_RELAYER = '0x842F655C9310C32e5932A0eBFa80c4Cd358c0205' as const;

/** Ophis-deployed GPv2VaultRelayer on Unichain (130). Confirmed via settlement.vaultRelayer() on-chain. */
const OPHIS_UNICHAIN_VAULT_RELAYER = '0xaB29E2a859704C914E55566Ae9b3A7EDE25959cb' as const;

export const OPHIS_VAULT_RELAYER_ADDRESSES: Readonly<Partial<Record<number, `0x${string}`>>> = Object.freeze({
  1: CANONICAL_COW_VAULT_RELAYER,
  100: CANONICAL_COW_VAULT_RELAYER,
  42161: CANONICAL_COW_VAULT_RELAYER,
  8453: CANONICAL_COW_VAULT_RELAYER,
  137: CANONICAL_COW_VAULT_RELAYER,
  43114: CANONICAL_COW_VAULT_RELAYER,
  56: CANONICAL_COW_VAULT_RELAYER,
  59144: CANONICAL_COW_VAULT_RELAYER,
  9745: CANONICAL_COW_VAULT_RELAYER,
  57073: CANONICAL_COW_VAULT_RELAYER,
  11155111: CANONICAL_COW_VAULT_RELAYER,
  10: OPHIS_VAULT_RELAYER, // Optimism — Ophis self-hosted relayer (NOT canonical)
  130: OPHIS_UNICHAIN_VAULT_RELAYER, // Unichain — Ophis self-hosted relayer (NOT canonical; confirmed via settlement.vaultRelayer())
  4326: OPHIS_VAULT_RELAYER, // MegaETH — same deterministic Ophis relayer (orderbook paused)
  999: OPHIS_HYPEREVM_VAULT_RELAYER, // HyperEVM — Ophis relayer (orderbook paused)
});

/**
 * Returns the GPv2VaultRelayer (the `approve` spender) for a chain. Throws on an
 * invalid or unsupported chainId. Use this for the one-time sell-token approval:
 * approving the canonical relayer on an Ophis-operated chain (e.g. Optimism)
 * leaves first sells unfillable.
 *
 * @example
 *   const relayer = getOphisVaultRelayer(10); // 0x83847EaB… on Optimism, NOT the canonical relayer
 *   await sellToken.approve(relayer, amount);
 */
export const getOphisVaultRelayer = (chainId: number): `0x${string}` => {
  assertValidChainId(chainId);
  const address = OPHIS_VAULT_RELAYER_ADDRESSES[chainId];
  if (!address) {
    throw new Error(
      `Ophis: no vault relayer for chainId ${chainId}. Supported: ${Object.keys(OPHIS_VAULT_RELAYER_ADDRESSES).join(', ')}.`,
    );
  }
  return address;
};
