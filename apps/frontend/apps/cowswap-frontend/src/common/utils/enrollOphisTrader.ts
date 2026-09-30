import { getTimeoutAbortController } from '@cowprotocol/common-utils'
import { getAddressKey } from '@cowprotocol/cow-sdk'

const REBATES_API = process.env.REACT_APP_REBATES_API ?? 'https://rebates.ophis.fi'
const inFlight = new Map<string, Promise<boolean>>()

/** Shared by Redux orders and TWAP. Renew per submission, deduplicating in-flight calls only. */
export function enrollOphisTrader(owner: string | null | undefined): Promise<boolean> {
  if (!owner || !/^0x[0-9a-f]{40}$/i.test(owner) || /^0x0{40}$/i.test(owner)) return Promise.resolve(false)
  const address = getAddressKey(owner)
  const pending = inFlight.get(address)
  if (pending) return pending
  const request = Promise.resolve()
    .then(() => fetch(`${REBATES_API}/tier/${address}`, { signal: getTimeoutAbortController(5000).signal }))
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => inFlight.delete(address))
  inFlight.set(address, request)
  return request
}
