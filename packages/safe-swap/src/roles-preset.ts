/**
 * Zodiac Roles Modifier v2 presets for a vault-curator role.
 *
 * TWO presets, for the TWO curator models. PICK ONE:
 *
 *  - `ophisVaultModuleRolesPreset({ module })` — **Phase B, RECOMMENDED.** For a
 *    vault that has enabled the on-chain `OphisVaultPolicyModule`. Scopes the
 *    curator to ONLY `module.rebalance` + `module.cancel` and denies raw
 *    approve / setPreSignature / enableModule / everything else. Because the
 *    module enforces receiver == vault + allowlist + oracle floor + fee
 *    ON-CHAIN, this preset gives the real "a compromised curator key cannot
 *    drain the vault" guarantee. Use this whenever the module is deployed.
 *
 *  - `ophisCuratorRolesPreset({ chainId, sellTokens })` — **Phase A, LEGACY.**
 *    For the direct-presign model (no policy module). Bounds the on-chain
 *    SURFACE only; a compromised curator CAN still drain (see its own
 *    !! SECURITY !! note). Use ONLY when no policy module is deployed, and
 *    treat the curator key as full vault custody.
 *
 * ---
 *
 * Phase-A preset detail (M3).
 *
 * A curator that drives rebalances through a Zodiac Roles Modifier (rather than an
 * MPC owner key, see ./exec-safe) should scope the curator ROLE to EXACTLY the two
 * calls buildOphisSafePresign emits, and nothing else. The Roles Modifier is
 * default-DENY: only the targets/functions listed here are permitted, so every
 * other call (transfer, transferFrom, approving a foreign spender, presigning on
 * the canonical CoW settlement, any other target) is rejected on-chain even if the
 * curator key is compromised.
 *
 * Scope granted:
 *  1. approve(spender, amount) on each vault underlying, with `spender` PINNED to
 *     the Ophis relayer (getOphisVaultRelayer). Amount is unconstrained because it
 *     varies per rebalance; the on-chain surface is still bounded to the relayer,
 *     and the off-chain builder already sets it exact. transfer / transferFrom on
 *     the same token are NOT listed, so they are denied.
 *  2. setPreSignature(orderUid, signed) on the OPHIS settlement only
 *     (getOphisSettlementAddress). The orderUid embeds the Safe as owner and the
 *     settlement enforces msg.sender == owner, so only the Safe's own orders can be
 *     presigned; the canonical CoW settlement is a different address and is denied.
 *
 * Both are ExecutionOptions.None (plain CALL, no value, no delegatecall).
 *
 * Returns a PermissionSet (data). Apply it to the curator role with the
 * zodiac-roles-sdk apply flow (processPermissions -> the Roles Modifier calls);
 * this module never touches the chain. Imported only via the
 * "@ophis/safe-swap/roles-preset" subpath; needs zodiac-roles-sdk (an OPTIONAL peer).
 *
 * !! SECURITY (Phase A) !! This preset bounds the on-chain SURFACE (which targets /
 * selectors the role may call), NOT the SEMANTICS of the calldata. A COMPROMISED
 * curator role member can still DRAIN the listed sellTokens: `approve` pins the
 * spender to the relayer but leaves the AMOUNT unconstrained, and `setPreSignature`
 * places no condition on the order uid - so the key can approve(relayer, MaxUint)
 * and presign a self-crafted order (owner = the Safe, receiver = attacker,
 * minOut ~ 0), then settle it (on a self-hosted chain the attacker can act as
 * solver). GPv2 only checks uid.owner == msg.sender == the Safe, which holds.
 *
 * Until the Phase-B EIP-1271 policy module ships (it decodes the FULL order and
 * enforces receiver == vault + token allowlist + minOut >= oracle before the
 * digest is honoured), treat the curator Roles key as FULL VAULT-OWNER-LEVEL
 * CUSTODY: grant it only to a key you would trust to move vault funds directly.
 * The preset's Phase-A value is confining a not-yet-abused key to the two Ophis
 * call shapes and denying every other target/selector; it is NOT a "curator cannot
 * drain even if its key leaks" guarantee.
 */
import { getOphisSettlementAddress, getOphisVaultRelayer } from '@ophis/sdk';
import { c, type PermissionSet } from 'zodiac-roles-sdk';

type Address = `0x${string}`;

export interface OphisCuratorRolesParams {
  chainId: number;
  /** The vault underlyings the curator may approve to the Ophis relayer. */
  sellTokens: Address[];
}

export function ophisCuratorRolesPreset(p: OphisCuratorRolesParams): PermissionSet {
  if (!p.sellTokens.length) throw new Error('ophisCuratorRolesPreset: at least one sellToken is required');

  const relayer = getOphisVaultRelayer(p.chainId) as Address;
  const settlement = getOphisSettlementAddress(p.chainId) as Address;

  const permissions = [
    // (1) approve(relayer, *) on each underlying — spender pinned to the Ophis relayer.
    ...p.sellTokens.map((token) => ({
      targetAddress: token,
      signature: 'approve(address,uint256)',
      condition: c.calldataMatches([c.eq(relayer)], ['address', 'uint256']),
    })),
    // (2) setPreSignature(uid, signed) on the Ophis settlement only.
    {
      targetAddress: settlement,
      signature: 'setPreSignature(bytes,bool)',
    },
  ];

  return permissions as PermissionSet;
}

/** The full GPv2Order.Data tuple signature, as OphisVaultPolicyModule.rebalance takes it. */
const REBALANCE_SIG =
  'rebalance((address,address,address,uint256,uint256,uint32,bytes32,uint256,bytes32,bool,bytes32,bytes32),uint256)';
const CANCEL_SIG = 'cancel(bytes)';

export interface OphisVaultModuleRolesParams {
  /** The deployed `OphisVaultPolicyModule` instance enabled on the vault Safe. */
  module: Address;
}

/**
 * Phase-B preset: scope the curator role to EXACTLY the vault policy module's
 * `rebalance` + `cancel`, and nothing else. THIS is the preset that delivers the
 * "a compromised curator key cannot drain the vault" guarantee, because the
 * module enforces the full order policy (receiver == vault, token allowlist,
 * oracle floor, pinned Ophis fee, turnover cap) ON-CHAIN, and this preset denies
 * the curator every other target/selector — crucially raw `approve` /
 * `setPreSignature` on the Safe (which would let a compromised key presign a
 * drain order directly, bypassing the module) and `enableModule` /
 * `setFallbackHandler` / `setGuard` (which would let it swap the policy).
 *
 * No calldata conditions are needed: the module IS the policy, so the Roles
 * layer only has to confine the curator to the module's two entrypoints. The
 * Roles Modifier is default-DENY, so everything unlisted is rejected.
 *
 * Apply it to the curator role via the zodiac-roles-sdk apply flow. Needs
 * zodiac-roles-sdk (an OPTIONAL peer); imported via "@ophis/safe-swap/roles-preset".
 */
export function ophisVaultModuleRolesPreset(p: OphisVaultModuleRolesParams): PermissionSet {
  if (!p.module) throw new Error('ophisVaultModuleRolesPreset: module address is required');

  const permissions = [
    { targetAddress: p.module, signature: REBALANCE_SIG },
    { targetAddress: p.module, signature: CANCEL_SIG },
  ];

  return permissions as PermissionSet;
}
