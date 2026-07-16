/**
 * Zodiac Roles Modifier v2 preset for a vault-curator role (M3).
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
 * Residual (same as ./exec-safe, disclosed in the design spec): presign + Roles
 * bound the on-chain SURFACE but cannot enforce receiver / fee / minOut inside the
 * setPreSignature calldata. The Phase-B EIP-1271 policy module closes that.
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
