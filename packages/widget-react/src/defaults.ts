import {
  OPHIS_PARTNER_FEE_RECIPIENT,
  ophisVolumeBpsForPair,
} from '@ophis/sdk';
import type { CowSwapWidgetParams } from '@cowprotocol/widget-react';

/** Canonical Ophis swap host the widget iframe loads. */
export const OPHIS_WIDGET_BASE_URL = 'https://swap.ophis.fi';

/**
 * appCode that tags every order placed through the widget. Mirrors the
 * frontend default (`appCode: 'Ophis'` in cowswap-frontend appData) so widget
 * orders share the Ophis appData identity.
 */
export const OPHIS_WIDGET_APP_CODE = 'Ophis';

/**
 * The widget's `PartnerFee` type is `{ bps, recipient }` (FlexibleConfig).
 * The SDK exposes the fee as `{ volumeBps, recipient }`. We map volumeBps -> bps
 * here. `bps` is the volume fee in basis points; 10 = 0.10% (1 for same-chain
 * stable pairs, but the widget cannot know the pair ahead of time, so we default
 * to the standard rate and let same-chain-stable handling stay server-side).
 */
export const OPHIS_WIDGET_PARTNER_FEE: NonNullable<CowSwapWidgetParams['partnerFee']> = {
  bps: ophisVolumeBpsForPair(false), // 10 bps standard volume fee
  recipient: OPHIS_PARTNER_FEE_RECIPIENT,
};

/**
 * Merge Ophis defaults into caller-supplied params. Caller values win for every
 * field EXCEPT the fee recipient: we always pin `partnerFee.recipient` to the
 * Ophis Safe so an integrator cannot (accidentally or otherwise) redirect the
 * Ophis fee. They can still tune `partnerFee.bps`, theme, tokens, etc.
 */
export function withOphisDefaults(params: CowSwapWidgetParams): CowSwapWidgetParams {
  const callerFee = params.partnerFee;

  return {
    ...params,
    // Fill the Ophis defaults only where the caller left them unset (spread
    // first, then nullish-coalesce, so caller values win without the
    // literal-before-spread shadowing TS rejects as TS2783).
    appCode: params.appCode ?? OPHIS_WIDGET_APP_CODE,
    baseUrl: params.baseUrl ?? OPHIS_WIDGET_BASE_URL,
    // Always enforce the Ophis recipient; honour a caller bps override.
    partnerFee: {
      bps: callerFee?.bps ?? OPHIS_WIDGET_PARTNER_FEE.bps,
      recipient: OPHIS_WIDGET_PARTNER_FEE.recipient,
    },
  };
}
