import {
  OPHIS_PARTNER_FEE_RECIPIENT,
  ophisVolumeBpsForPair,
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
 * here. `bps` is the volume fee in basis points; 5 = 0.05% the @ophis/sdk partner
 * rate (1 for same-chain stable pairs, but the widget cannot know the pair ahead
 * of time, so we default to the standard rate and let same-chain-stable handling
 * stay server-side).
 */
export const OPHIS_WIDGET_PARTNER_FEE: NonNullable<CowSwapWidgetParams['partnerFee']> = {
  bps: ophisVolumeBpsForPair(false), // 5 bps partner volume fee
  recipient: OPHIS_PARTNER_FEE_RECIPIENT,
};

/**
 * Merge Ophis defaults into caller-supplied params. Caller values win for every
 * field EXCEPT the fee recipient: we always pin `partnerFee.recipient` to the
 * Ophis Safe so an integrator cannot (accidentally or otherwise) redirect the
 * Ophis fee. They can still tune `partnerFee.bps`, theme, tokens, etc.
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
    // Always enforce the Ophis recipient; honour a caller bps override.
    partnerFee: {
      bps: callerFee?.bps ?? OPHIS_WIDGET_PARTNER_FEE.bps,
      recipient: OPHIS_WIDGET_PARTNER_FEE.recipient,
    },
  };
}
