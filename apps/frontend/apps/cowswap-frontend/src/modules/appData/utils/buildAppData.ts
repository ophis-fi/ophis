import { UtmParams } from '@cowprotocol/common-utils'
import { stringifyDeterministic } from '@cowprotocol/cow-sdk'

import { metadataApiSDK } from 'cowSdk'

import { toKeccak256 } from 'common/utils/toKeccak256'

import { filterHooks, HooksFilter } from './appDataFilter'
import { ophisReferrerForRefCode } from './ophisReferrer'
import { removePermitHookFromHooks, typedAppDataHooksToAppDataHooks } from './typedHooks'

import { UserConsentsMetadata } from '../hooks/useRwaConsentForAppData'
import {
  AppDataHooks,
  AppDataInfo,
  AppDataOrderClass,
  AppDataPartnerFee,
  AppDataRootSchema,
  AppDataWidget,
  TypedAppDataHooks,
} from '../types'

export type BuildAppDataParams = {
  appCode: string
  environment?: string
  slippageBips: number
  isSmartSlippage?: boolean
  orderClass: AppDataOrderClass
  refCode?: string
  utm: UtmParams | undefined
  typedHooks?: TypedAppDataHooks
  widget?: AppDataWidget
  partnerFee?: AppDataPartnerFee
  replacedOrderUid?: string
  userConsent?: UserConsentsMetadata
}

async function generateAppDataFromDoc(
  doc: AppDataRootSchema,
): Promise<Pick<AppDataInfo, 'fullAppData' | 'appDataKeccak256'>> {
  const fullAppData = await stringifyDeterministic(doc)
  const appDataKeccak256 = toKeccak256(fullAppData)
  return { fullAppData, appDataKeccak256 }
}

export async function buildAppData({
  slippageBips,
  isSmartSlippage,
  refCode,
  appCode,
  environment,
  orderClass: orderClassName,
  utm,
  typedHooks,
  widget,
  partnerFee,
  replacedOrderUid,
  userConsent,
}: BuildAppDataParams): Promise<AppDataInfo> {
  const referrerParams: AppDataRootSchema['metadata']['referrer'] = refCode ? { code: refCode } : undefined
  // On-chain partner attribution: for registered ON_CHAIN_PARTNER_REF_CODES only, embed the
  // ref code at metadata.ophisReferrer.code (the field the rebate indexer credits from chain).
  // undefined for affiliate/unknown codes → no on-chain tag (they keep the /ref/bind arm).
  const ophisReferrer = ophisReferrerForRefCode(refCode)

  const quoteParams = {
    slippageBips,
    ...(isSmartSlippage !== undefined ? { smartSlippage: isSmartSlippage } : undefined),
  }
  const orderClass = { orderClass: orderClassName }
  const replacedOrder = replacedOrderUid ? { uid: replacedOrderUid } : undefined

  const doc = await metadataApiSDK.generateAppDataDoc({
    appCode,
    environment,
    metadata: {
      referrer: referrerParams,
      quote: quoteParams,
      orderClass,
      utm,
      hooks: typedAppDataHooksToAppDataHooks(typedHooks),
      widget,
      partnerFee,
      ...{ replacedOrder },
      ...(userConsent ? userConsent : {}),
      // Ophis extension key (partner codes only). generateAppDataDoc is a NON-validating
      // shallow merge, so this survives verbatim into the signed fullAppData; the CoW
      // orderbook accepts it (we never call validateAppDataDoc, which rejects
      // additionalProperties). The rebate indexer reads metadata.ophisReferrer.code.
      ...(ophisReferrer ? { ophisReferrer } : {}),
    } as AppDataRootSchema['metadata'],
  })

  const { fullAppData, appDataKeccak256 } = await generateAppDataFromDoc(doc)

  return { doc, fullAppData, appDataKeccak256 }
}

export async function replaceHooksOnAppData(
  appData: AppDataInfo,
  hooks: AppDataHooks | undefined,
  preHooksFilter?: HooksFilter,
  postHooksFilter?: HooksFilter,
): Promise<AppDataInfo> {
  const { doc } = appData

  const filteredHooks = filterHooks(hooks, preHooksFilter, postHooksFilter)

  const newDoc = {
    ...doc,
    metadata: {
      ...doc.metadata,
      hooks: filteredHooks,
    },
  }

  if (!newDoc.metadata.hooks) {
    delete newDoc.metadata.hooks
  }

  const { fullAppData, appDataKeccak256 } = await generateAppDataFromDoc(newDoc)

  return {
    doc: newDoc,
    fullAppData,
    appDataKeccak256,
  }
}

export function removePermitHookFromAppData(
  appData: AppDataInfo,
  typedHooks: TypedAppDataHooks | undefined,
): Promise<AppDataInfo> {
  return replaceHooksOnAppData(appData, removePermitHookFromHooks(typedHooks))
}
