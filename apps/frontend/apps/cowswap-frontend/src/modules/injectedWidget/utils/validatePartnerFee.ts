import { isTruthy } from '@cowprotocol/common-utils'
import { areAddressesEqual, SupportedChainId } from '@cowprotocol/cow-sdk'
import { PartnerFee, resolveFlexibleConfig, resolveFlexibleConfigValues, TradeType } from '@cowprotocol/widget-lib'
import { getAddress } from '@ethersproject/address'

import { t } from '@lingui/core/macro'

import { OPHIS_MAX_PARTNER_REQUEST_BPS, OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import { PARTNER_FEE_MAX_BPS } from '../consts'

export function validatePartnerFee(input: PartnerFee | undefined): string[] | undefined {
  if (!input) return undefined

  const bpss = resolveFlexibleConfigValues(input.bps)
  const recipients = resolveFlexibleConfigValues(input.recipient)

  const feeTooHighError = bpss.some((value) => value > PARTNER_FEE_MAX_BPS)
    ? t`Partner fee can not be more than ${PARTNER_FEE_MAX_BPS} BPS!`
    : undefined
  // A fee paid to a THIRD-PARTY recipient is stacked with the Ophis policy (1 bp
  // base + capped price improvement, up to 100 bps on a volatile pair), so its
  // ceiling is the registered-integrator request cap: 90 + 100 = the 190 bps
  // aggregate cap on Ophis-operated chains, and CoW-hosted chains clamp their
  // 100 bps aggregate in array order with the host entry first. A fee paid TO the
  // Ophis Safe (the @ophis/widget-react wrapper pins that recipient) is not
  // stacked, so the plain PARTNER_FEE_MAX_BPS ceiling above is the only one.
  // bps and recipient are independent FlexibleConfigs (per network, per trade
  // type), so pair them per (chain, trade type) rather than flattening each: a
  // 100 bps fee to the Ophis Safe on one chain next to 50 bps to a third party
  // on another is valid.
  const stackedFeeTooHigh = Object.values(SupportedChainId)
    .filter((v): v is SupportedChainId => typeof v === 'number')
    .some((chainId) =>
      Object.values(TradeType).some((tradeType) => {
        const bps = resolveFlexibleConfig(input.bps, chainId, tradeType)
        const recipient = resolveFlexibleConfig(input.recipient, chainId, tradeType)
        return (
          typeof bps === 'number' &&
          bps > OPHIS_MAX_PARTNER_REQUEST_BPS &&
          bps <= PARTNER_FEE_MAX_BPS &&
          typeof recipient === 'string' &&
          !areAddressesEqual(recipient, OPHIS_PARTNER_FEE_RECIPIENT)
        )
      }),
    )
  const stackedFeeTooHighError = stackedFeeTooHigh
    ? t`Partner fee paid to your own address can not be more than ${OPHIS_MAX_PARTNER_REQUEST_BPS} BPS: Ophis adds its own fee on top.`
    : undefined
  const feeTooLowError = bpss.some((value) => value < 0) ? t`Partner fee can not be less than 0!` : undefined
  const recipientErrors = validateRecipients(recipients)

  const errors = [feeTooHighError, stackedFeeTooHighError, feeTooLowError, ...recipientErrors].filter(isTruthy)

  return errors.length > 0 ? errors : undefined
}

function validateRecipients(recipients: PartnerFee['recipient'][]): (string | undefined)[] {
  return recipients.map((recipient) => {
    if (!recipient) return t`Partner fee recipient must be set!`

    if (typeof recipient === 'string') return validateRecipientAddress(recipient)

    const errors = Object.values(recipient).map(validateRecipientAddress).filter(isTruthy)

    return errors.length > 0 ? errors.join(', ') : undefined
  })
}

function validateRecipientAddress(recipient: string): string | undefined {
  try {
    getAddress(recipient)
  } catch (error) {
    return error.message
  }

  return undefined
}
