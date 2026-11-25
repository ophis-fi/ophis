import { OPHIS_SOLANA_CONFIG } from 'entities/solana'
import { atomWithQuery } from 'jotai-tanstack-query'

const privateApi = 'http://127.0.0.1:18580/'
export const privateSettlementEnabled =
  process.env.REACT_APP_OPHIS_PRIVATE_SOLVER === '1' &&
  OPHIS_SOLANA_CONFIG?.chain === 'solana:mainnet' &&
  OPHIS_SOLANA_CONFIG.api === privateApi &&
  typeof window !== 'undefined' &&
  window.location.origin === 'http://127.0.0.1:4324'

export const privateWalletRpc = privateSettlementEnabled ? privateApi + 'private/wallet-rpc' : undefined

export type PrivateSettlement =
  | { state: 'ready' }
  | { state: 'pending' | 'confirmed' | 'expired' | 'failed'; signature: string }
  | {
      state: 'review'
      deadline: number
      received: string
      minimum: string
      buyMint: string
      venue: string
      fee: string
      deposits: string
    }

export async function privateAction<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  if (!privateSettlementEnabled) throw Error('Private wallet settlement is unavailable.')
  const response = await fetch(privateApi + 'private/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(action === 'prepare' ? 80000 : 30000),
  })
  const data = await response.json()
  if (!response.ok) throw Error(typeof data.error === 'string' ? data.error : 'Private settlement request failed.')
  return data
}

export const privateModeAtom = atomWithQuery(() => ({
  queryKey: ['private-solana-operator', privateApi],
  enabled: privateSettlementEnabled,
  queryFn: () =>
    privateAction<{ automatic: boolean; nativePayout: boolean; walletChoice?: boolean; requiredVenue?: string }>(
      'mode',
      {},
    ),
  staleTime: 15_000,
  retry: false,
}))
