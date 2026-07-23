/**
 * Zodiac Roles Modifier v2 preset for a vault-curator role — the PHASE-A
 * (direct-presign) model only.
 *
 * NOTE on the Phase-B policy module (`OphisVaultPolicyModule`): it does NOT use
 * a Zodiac Roles preset. A Roles Modifier routes a role member's call THROUGH
 * the Safe avatar (`avatar.execTransactionFromModule`), so the module would see
 * `msg.sender == the Safe`, and the module both gates on `msg.sender == curator`
 * and rejects `curator == the Safe` at construction — every Roles-routed call
 * would revert `NotCurator`. Instead, the Phase-B curator is a DIRECT CALLER of
 * the module: a dedicated EOA / MPC signer / multisig contract that calls
 * `module.rebalance` / `module.cancel` directly and is NOT a Safe owner or an
 * enabled Safe module. Its confinement is intrinsic: (1) the module enforces the
 * full order policy on-chain, so even the curator can only produce policy-valid
 * rebalances, and (2) with no owner/module rights it has no other way to touch
 * the Safe. That combination — not a Roles preset — delivers "a compromised
 * curator key cannot drain the vault." For multi-member / revocable access, use
 * a multisig or governance contract as the curator. (This preset below is only
 * for the Phase-A direct-presign model, where the curator DOES need Safe
 * approve/presign rights and therefore benefits from Roles surface-bounding.)
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
