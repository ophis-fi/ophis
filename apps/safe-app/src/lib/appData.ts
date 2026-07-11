// cow-sdk v5 no longer re-exports the appData helpers from its root; they live in
// @cowprotocol/app-data (a cow-sdk dependency, pinned here as a direct dep at the same
// major). MetadataApi.generateAppDataDoc is a shallow {...defaults, ...params} merge with
// NO schema validation, so the Ophis-specific metadata (partnerFee.volumeBps and the custom
// ophisReferrer key, neither of which is in CoW's stock Metadata type) is preserved verbatim.
import { MetadataApi, stringifyDeterministic } from '@cowprotocol/app-data';
import { keccak256, toUtf8Bytes } from 'ethers';
import { buildOphisAppDataPartnerFee, buildOphisOrderMetadata, type OphisAppDataInput } from '@ophis/sdk';

// The partner fee (to the Ophis Safe) and the referrer code are carried ENTIRELY in appData.
// This is the rev-share carrier; the Safe's only on-chain action is setPreSignature.
//
// CRITICAL: appCode MUST be the lowercase literal 'ophis'. The rebate indexer's accrual path
// only honours appCode in {'ophis','greg'} (apps/rebate-indexer/src/cow/types.ts APP_CODES) and
// reads it RAW with no case-folding, so emitting 'Ophis' (capitalised) makes every order silently
// forfeit its rebate. We get this via @ophis/sdk's buildOphisOrderMetadata (which hardcodes
// 'ophis' and assembles the referrer tag) when a referral code is present, and assemble the same
// lowercase shape by hand when it is not (buildOphisOrderMetadata requires a referral code).
export async function buildAppData(
  chainId: number,
  owner: `0x${string}`,
  referralCode?: string,
) {
  // `signer` = the Safe address: it is an EIP-1271 contract signer, so it goes in
  // appData.metadata.signer.
  let input: OphisAppDataInput | { appCode: 'ophis'; metadata: Record<string, unknown> };
  if (referralCode) {
    // buildOphisOrderMetadata REQUIRES a referral code; it also throws on a chain with no live
    // orderbook (defence in depth on top of the SwapForm chain gate). appCode is 'ophis'.
    input = buildOphisOrderMetadata({ chainId, referralCode, signer: owner });
  } else {
    // No referral code: assemble the same lowercase-appCode metadata by hand, sans ophisReferrer.
    const partnerFee = buildOphisAppDataPartnerFee(chainId); // { volumeBps, recipient: Ophis Safe }
    input = {
      appCode: 'ophis', // MUST be lowercase so the rebate indexer does not drop the order
      metadata: { partnerFee, signer: owner, hooks: {} },
    };
  }

  // Cast: metadata carries the fork's partnerFee shape ({ volumeBps, recipient }) + the custom
  // ophisReferrer tag, which the stock CoW Metadata type (partnerFee.bps, no ophisReferrer) rejects.
  // generateAppDataDoc passes metadata through untouched, so the on-the-wire payload is exact.
  // We deliberately DO NOT call validateAppDataDoc/getAppDataInfo: CoW's strict schema
  // (additionalProperties: false) rejects the ophisReferrer extension key, but the orderbook
  // accepts it. Keep the non-validating hash path.
  const doc = await new MetadataApi().generateAppDataDoc(input as any);

  const fullAppData = await stringifyDeterministic(doc);
  // Hash the DETERMINISTIC string, never keccak256(JSON.stringify(doc)).
  const appDataHash = keccak256(toUtf8Bytes(fullAppData));
  return { fullAppData, appDataHash };
}
