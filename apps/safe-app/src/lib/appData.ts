// cow-sdk v5 no longer re-exports the appData helpers from its root; they live in
// @cowprotocol/app-data (a cow-sdk dependency, pinned here as a direct dep at the same
// major). MetadataApi.generateAppDataDoc is a shallow {...defaults, ...params} merge with
// NO schema validation, so the Ophis-specific metadata (partnerFee.volumeBps and the custom
// ophisReferrer key, neither of which is in CoW's stock Metadata type) is preserved verbatim.
import { MetadataApi, stringifyDeterministic } from '@cowprotocol/app-data';
import { keccak256, toUtf8Bytes } from 'ethers';
import { buildOphisAppDataPartnerFee, buildOphisReferrerMetadata } from '@ophis/sdk';

// The partner fee (to the Ophis Safe) and the referrer code are carried ENTIRELY in appData.
// This is the rev-share carrier; the Safe's only on-chain action is setPreSignature.
export async function buildAppData(chainId: number, referralCode?: string) {
  const partnerFee = buildOphisAppDataPartnerFee(chainId); // { volumeBps, recipient: Ophis Safe }
  const referrer = referralCode ? buildOphisReferrerMetadata(referralCode) : {};

  // Cast: metadata carries the fork's partnerFee shape ({ volumeBps, recipient }) + the custom
  // ophisReferrer tag, which the stock CoW Metadata type (partnerFee.bps, no ophisReferrer) rejects.
  // generateAppDataDoc passes metadata through untouched, so the on-the-wire payload is exact.
  const doc = await new MetadataApi().generateAppDataDoc({
    appCode: 'Ophis', // MUST match the fork's appCode so fee classification + attribution line up
    metadata: { partnerFee, ...referrer, hooks: {} } as any,
  });

  const fullAppData = await stringifyDeterministic(doc);
  // Hash the DETERMINISTIC string, never keccak256(JSON.stringify(doc)).
  const appDataHash = keccak256(toUtf8Bytes(fullAppData));
  return { fullAppData, appDataHash };
}
