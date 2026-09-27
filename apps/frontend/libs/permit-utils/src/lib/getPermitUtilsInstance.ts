import type { JsonRpcProvider } from '@ethersproject/providers'

import { PERMIT_SIGNER } from '../const'
import { PermitProviderConnector } from '../utils/PermitProviderConnector'

import type { Eip2612PermitUtils } from '@1inch/permit-signed-approvals-utils'

// Both static and user permits read through the provider captured by their connector.
const PROVIDER_UTILS_CACHE = new WeakMap<JsonRpcProvider, Map<string, Eip2612PermitUtils>>()

export async function getPermitUtilsInstance(
  chainId: number,
  provider: JsonRpcProvider,
  account?: string | undefined,
): Promise<Eip2612PermitUtils> {
  const providerCache = PROVIDER_UTILS_CACHE.get(provider) ?? new Map<string, Eip2612PermitUtils>()
  PROVIDER_UTILS_CACHE.set(provider, providerCache)
  const providerCacheKey = `${chainId}-${account}`
  const cachedUtils = providerCache.get(providerCacheKey)

  if (cachedUtils) {
    return cachedUtils
  }

  // TODO: allow to receive the signer as a parameter
  const web3ProviderConnector = new PermitProviderConnector(provider, account ? undefined : PERMIT_SIGNER)
  const Eip2612PermitUtilsClass = await import('../imports/1inchPermitUtils').then((r) => r.Eip2612PermitUtils)
  const eip2612PermitUtils = new Eip2612PermitUtilsClass(web3ProviderConnector, { enabledCheckSalt: true })

  providerCache.set(providerCacheKey, eip2612PermitUtils)

  return eip2612PermitUtils
}
