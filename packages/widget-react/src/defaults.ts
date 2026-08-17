import {
  OPHIS_FEE_CHAIN_IDS,
  OPHIS_PARTNER_FEE_RECIPIENT,
  ophisVolumeBpsForChainAndPair,
} from '@ophis/sdk';
import type { CowSwapWidgetParams } from '@cowprotocol/widget-react';

/** Canonical Ophis swap host the widget iframe loads. */
export const OPHIS_WIDGET_BASE_URL = 'https://swap.ophis.fi';

/**
 * appCode that tags every order placed through the widget. LOWERCASE 'ophis':
 * the rebate indexer recognizes Ophis orders by a case-sensitive match against
 * the lowercase APP_CODES set, so a capitalized appCode would drop the order from
 * attribution. Mirrors the frontend default (`appCode: 'ophis'`).
 */
export const OPHIS_WIDGET_APP_CODE = 'ophis';

/**
 * The widget's `PartnerFee` type is `{ bps, recipient }` (FlexibleConfig).
 * The SDK exposes the fee as `{ volumeBps, recipient }`. We map volumeBps -> bps
 * here. Keep `bps` as a per-network FlexibleConfig: the embedded widget resolves
 * it against the active wallet chain after every network switch. Collapsing it
 * against the initial `params.chainId` would make that initial fee stick.
 */
export const OPHIS_WIDGET_PARTNER_FEE: NonNullable<CowSwapWidgetParams['partnerFee']> = {
  bps: Object.freeze(Object.fromEntries(
    OPHIS_FEE_CHAIN_IDS.map((chainId) => [chainId, ophisVolumeBpsForChainAndPair(chainId, false)]),
  )) as NonNullable<CowSwapWidgetParams['partnerFee']>['bps'],
  recipient: OPHIS_PARTNER_FEE_RECIPIENT,
};

/**
 * Merge Ophis defaults into caller-supplied params. When the caller does not
 * explicitly provide `partnerFee`, omit the widget param so swap.ophis.fi can
 * apply its complete base + improvement policy. When the caller does provide
 * one, preserve its bps and pin only the recipient; the iframe then treats the
 * explicit volume override as authoritative.
 */
/**
 * Treat a blank or whitespace-only string as "unset". Integrators routinely
 * thread `baseUrl`/`appCode` from optional env/config that resolves to `''`
 * when missing. A plain `?? default` keeps that `''`, and because this wrapper
 * depends on the PUBLISHED `@cowprotocol/widget-react` (whose sanitizer falls
 * back to the CoW host, not the Ophis-flipped vendored default), a blank
 * `baseUrl` would silently load swap.cow.fi instead of the Ophis surface. So we
 * normalize blanks to the Ophis default here, before handing params upstream.
 */
function orDefault(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

export function withOphisDefaults(params: CowSwapWidgetParams): CowSwapWidgetParams {
  const callerFee = params.partnerFee;

  return {
    ...params,
    // Fill the Ophis defaults wherever the caller left them unset OR blank
    // (spread first, then override, so caller values win without the
    // literal-before-spread shadowing TS rejects as TS2783).
    appCode: orDefault(params.appCode, OPHIS_WIDGET_APP_CODE),
    baseUrl: orDefault(params.baseUrl, OPHIS_WIDGET_BASE_URL),
    ...(callerFee
      ? {
          partnerFee: {
            bps: callerFee.bps,
            recipient: OPHIS_WIDGET_PARTNER_FEE.recipient,
          },
        }
      : { partnerFee: undefined }),
  };
}
