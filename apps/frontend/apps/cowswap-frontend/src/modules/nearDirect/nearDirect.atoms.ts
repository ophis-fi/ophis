import { atom } from 'jotai'
import { atomFamily, atomWithStorage, createJSONStorage } from 'jotai/utils'

import { atomWithQuery } from 'jotai-tanstack-query'

import { NearTransfer, nearTransferSchema } from './nearDirect.schemas'
import {
  getNearTokens,
  getNearTransferStatus,
  isExpiredUnfundedNearTransfer,
  validateNearTransfer,
} from './nearDirect.service'

export const nearTokensAtom = atomWithQuery(() => ({
  queryKey: ['nearDirectTokens'],
  queryFn: getNearTokens,
  staleTime: 60_000,
}))

export function normalizeNearTransfers(value: unknown): NearTransfer[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const parsed = nearTransferSchema.safeParse(entry)
    if (!parsed.success) return []
    try {
      validateNearTransfer(parsed.data)
      return [parsed.data]
    } catch {
      return []
    }
  })
}

const json = createJSONStorage<unknown>()
const storage = {
  getItem: (key: string): NearTransfer[] => normalizeNearTransfers(json.getItem(key, [])),
  setItem: (key: string, value: NearTransfer[]): void => {
    json.setItem(key, value)
    if (JSON.stringify(json.getItem(key, [])) !== JSON.stringify(value)) {
      throw new Error('Unable to save swap recovery. Deposit instructions remain hidden.')
    }
  },
  removeItem: (key: string): void => json.removeItem(key),
  subscribe: (key: string, callback: (value: NearTransfer[]) => void): (() => void) =>
    json.subscribe?.(key, (value) => callback(normalizeNearTransfers(value)), []) ?? (() => undefined),
}

export function readStoredNearTransfer(signature: string): NearTransfer | undefined {
  return storage.getItem('nearDirectTransfers:v0').find((item) => item.response.signature === signature)
}
const transfersStoreAtom = atomWithStorage<NearTransfer[]>('nearDirectTransfers:v0', [], storage, {
  getOnInit: true,
})

export function pruneNearTransfers(transfers: NearTransfer[]): NearTransfer[] {
  let completed = 0
  // ponytail: retain 50 completed swaps; active/uncertain recovery is never evicted.
  return transfers
    .slice()
    .reverse()
    .filter((transfer) => !['SUCCESS', 'REFUNDED'].includes(transfer.status) || ++completed <= 50)
    .reverse()
}

export const nearTransfersAtom = atom(
  (get) => get(transfersStoreAtom),
  async (_get, set, update: NearTransfer[] | ((current: NearTransfer[]) => NearTransfer[])): Promise<void> => {
    if (!navigator.locks) throw new Error('This browser cannot safely save swap recovery. Use a current browser.')
    await navigator.locks.request('nearDirectTransfers', () => {
      const current = storage.getItem('nearDirectTransfers:v0')
      const next = pruneNearTransfers(typeof update === 'function' ? update(current) : update)
      // Persist before rendering instructions or allowing the wallet to sign.
      storage.setItem('nearDirectTransfers:v0', next)
      set(transfersStoreAtom, next)
    })
  },
)

export const nearTransferStatusAtom = atomFamily((signature: string) =>
  atomWithQuery((get) => {
    const transfer = get(nearTransfersAtom).find((item) => item.response.signature === signature)
    return {
      queryKey: ['nearDirectStatus', signature],
      queryFn: (): Promise<NearTransfer> => {
        if (!transfer) throw new Error('Swap recovery is missing.')
        return getNearTransferStatus(transfer)
      },
      enabled: !!transfer && !['SUCCESS', 'REFUNDED'].includes(transfer.status),
      refetchInterval: (): number | false => (transfer && isExpiredUnfundedNearTransfer(transfer) ? false : 10_000),
      retry: 1,
    }
  }),
)
