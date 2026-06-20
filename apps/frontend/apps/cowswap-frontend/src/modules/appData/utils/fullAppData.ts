import { EnvironmentName, environmentName } from '@cowprotocol/common-utils'
import { LATEST_APP_DATA_VERSION, LatestAppDataDocVersion } from '@cowprotocol/cow-sdk'

import { toKeccak256 } from 'common/utils/toKeccak256'

import { AppDataInfo } from '../types'

// NON-attributable fallback. This default is published as an order's appData only when buildAppData
// fails (AppDataInfoUpdater's catch) or before the per-order appData is built — and it carries NO
// partnerFee. The rebate indexer recognizes 'ophis'/'greg' case-insensitively (APP_CODES), so
// tagging this no-fee doc 'ophis' would attribute trader volume that paid no Ophis fee. Use an
// appCode OUTSIDE APP_CODES so a degraded/bootstrap order is never rebate-attributed (casing alone
// can't achieve this — the indexer lowercases on read). Real orders are tagged 'ophis' via
// REACT_APP_APP_CODE (useAppCode) in the appData built per order.
const DEFAULT_FULL_APP_DATA_OBJ = { version: LATEST_APP_DATA_VERSION, appCode: 'ophis-fallback', metadata: {} }
const DEFAULT_FULL_APP_DATA = JSON.stringify(DEFAULT_FULL_APP_DATA_OBJ)

const APP_DATA_PER_ENV: Record<EnvironmentName, string> = {
  production: process.env.REACT_APP_FULL_APP_DATA_PRODUCTION || addEnvToDefaultAppData('production'),
  ens: process.env.REACT_APP_FULL_APP_DATA_ENS || addEnvToDefaultAppData('ens'),
  barn: process.env.REACT_APP_FULL_APP_DATA_BARN || addEnvToDefaultAppData('barn'),
  staging: process.env.REACT_APP_FULL_APP_DATA_STAGING || addEnvToDefaultAppData('staging'),
  pr: process.env.REACT_APP_FULL_APP_DATA_PR || addEnvToDefaultAppData('pr'),
  development: process.env.REACT_APP_FULL_APP_DATA_DEVELOPMENT || addEnvToDefaultAppData('development'),
  local: process.env.REACT_APP_FULL_APP_DATA_LOCAL || addEnvToDefaultAppData('local'),
}

let appData: AppDataInfo = (() => {
  const fullAppData = getFullAppDataByEnv(environmentName)
  return _fromFullAppData(fullAppData)
})()

export function getAppData(): AppDataInfo {
  return appData
}

export function updateFullAppData(fullAppData: string | undefined): void {
  if (fullAppData) {
    appData = _fromFullAppData(fullAppData)
  }
}

export function getFullAppDataByEnv(environmentName: EnvironmentName | undefined): string {
  return (environmentName && APP_DATA_PER_ENV[environmentName]) || DEFAULT_FULL_APP_DATA
}

function addEnvToDefaultAppData(env: EnvironmentName): string {
  const appData: LatestAppDataDocVersion = { ...DEFAULT_FULL_APP_DATA_OBJ }
  appData.environment = env
  return JSON.stringify(appData)
}

function _fromFullAppData(fullAppData: string): AppDataInfo {
  return {
    doc: JSON.parse(fullAppData),
    fullAppData: fullAppData,
    appDataKeccak256: toKeccak256(fullAppData),
  }
}
