import { isTruthy } from '@cowprotocol/common-utils'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { PartnerFee, resolveFlexibleConfigValues } from '@cowprotocol/widget-lib'
import { getAddress } from '@ethersproject/address'

import { t } from '@lingui/core/macro'

import { OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import { PARTNER_FEE_MAX_BPS } from '../consts'

export function validatePartnerFee(input: PartnerFee | undefined): string[] | undefined {
  if (!input) return undefined

  const bpss = resolveFlexibleConfigValues(input.bps)
  const recipients = resolveFlexibleConfigValues(input.recipient)

  const feeTooHighError = bpss.some((value) => value > PARTNER_FEE_MAX_BPS)
    ? t`Partner fee can not be more than ${PARTNER_FEE_MAX_BPS} BPS!`
    : undefined
  const feeTooLowError = bpss.some((value) => value < 0) ? t`Partner fee can not be less than 0!` : undefined
  const recipientErrors = validateRecipients(recipients)

  const errors = [feeTooHighError, feeTooLowError, ...recipientErrors].filter(isTruthy)

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

  // The Ophis fee is not configurable from a widget: it is stacked automatically
  // on top of the host's own fee. A host naming the Ophis Safe would either
  // duplicate the base entry or silently be ignored, so refuse it outright.
  if (areAddressesEqual(recipient, OPHIS_PARTNER_FEE_RECIPIENT)) {
    return t`Partner fee recipient must be your own address: the Ophis fee is added automatically on top of yours.`
  }

  return undefined
}
