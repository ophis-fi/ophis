import { utils } from 'ethers'

import {
  DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK,
  OPHIS_PARTNER_FEE_RECIPIENT,
} from './feeRecipient'

/**
 * Phase 3 audit H1+H2 regression guard.
 *
 * Three independent files declared the partner-fee recipient before 2026-05-19:
 *   - packages/sdk/src/partner-fee.ts (OPHIS_PARTNER_FEE_RECIPIENT)
 *   - apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts (OPHIS_PARTNER_FEE_RECIPIENT)
 *   - apps/frontend/libs/common-const/src/feeRecipient.ts (per-network override map)
 *
 * The third file drifted: MegaETH (4326) was routed to a CoW default placeholder,
 * HyperEVM (999) was routed to the *protocol* Safe (governance multisig) rather
 * than the partner-fee Safe. This file's fix pulled both back to canonical;
 * the assertions below ensure no future edit silently reintroduces drift.
 *
 * Cross-file drift guard (Codex pre-PR review MED-1): each of the 3 source
 * files lives in a separate pnpm workspace and cannot transitively import
 * a single TS module. The drift guard works by having each file's test
 * suite assert against this HARDCODED literal. If any of the 3 source
 * constants ever changes, its own workspace's test fails. The literal
 * mismatch is intentional friction so a one-off override doesn't pass
 * review.
 *
 * If this canonical address ever needs to change (Safe rotation, redeploy),
 * update it in all 3 test files in the same PR.
 */
const CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'

describe('feeRecipient', () => {
  it('OPHIS_PARTNER_FEE_RECIPIENT equals the canonical literal (cross-file drift guard)', () => {
    expect(OPHIS_PARTNER_FEE_RECIPIENT).toBe(CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT)
  })

  it('exports a canonical EIP-55 partner-fee recipient', () => {
    // utils.getAddress (ethers v5) throws on non-canonical checksum.
    expect(() => utils.getAddress(OPHIS_PARTNER_FEE_RECIPIENT)).not.toThrow()
    // The canonical form should equal the constant exactly (no case drift).
    expect(utils.getAddress(OPHIS_PARTNER_FEE_RECIPIENT)).toBe(OPHIS_PARTNER_FEE_RECIPIENT)
  })

  it('routes Ophis-operated chains (OP, MegaETH, HL) to the canonical recipient', () => {
    // The 3 chains where we operate stacks must route to our Safe.
    // Per-chain entries existing AT ALL is also load-bearing — a refactor
    // deleting them would fall back to the base placeholder.
    const ophisChainIds = [10, 4326, 999] as const
    for (const chainId of ophisChainIds) {
      const entry = (DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK as Record<number, string>)[chainId]
      expect(entry).toBe(OPHIS_PARTNER_FEE_RECIPIENT)
    }
  })

  it('non-Ophis chains use the CoW default placeholder (third-party widget hosts get the default, not Ophis)', () => {
    // Sharp-edges MED-3 regression guard: the base mapping must NOT route
    // non-Ophis CoW chains to the Ophis Safe. Third-party widget hosts
    // embedding the CoW widget on Ethereum/Gnosis/etc. and not setting
    // their own recipient should fall through to CoW's default
    // placeholder, never to our Safe.
    const COW_DEFAULT_PLACEHOLDER = '0x22af3D38E50ddedeb7C47f36faB321eC3Bb72A76'
    const nonOphisChainIds = [1, 100, 8453, 42161, 137] as const
    for (const chainId of nonOphisChainIds) {
      const entry = (DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK as Record<number, string>)[chainId]
      expect(entry).toBe(COW_DEFAULT_PLACEHOLDER)
    }
  })

  it('routes every entry to a canonical EIP-55 address', () => {
    for (const recipient of Object.values(DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK)) {
      expect(() => utils.getAddress(recipient)).not.toThrow()
      expect(utils.getAddress(recipient)).toBe(recipient)
    }
  })
})
