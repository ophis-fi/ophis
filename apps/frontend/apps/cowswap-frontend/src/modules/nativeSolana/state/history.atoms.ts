import { atomFamily } from 'jotai/utils'

import { fetchWithTimeout } from '@cowprotocol/common-utils'

import { fetchOphisSolanaOrder, fetchOphisSolanaTrades, readOphisOrderAccount, solanaAddress } from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { atomWithQuery } from 'jotai-tanstack-query'

import { visibleNativeSolanaOrdersAtom } from './orders.atoms'

import { balanceEndpoint } from '../services/assets.service'

export const pageSize = 10
export const historyAtom = atomFamily((page: number) =>
  atomWithQuery((get) => {
    const owner = get(solanaConnectionAtom)?.account.address
    const config = OPHIS_SOLANA_CONFIG
    return {
      queryKey: ['ophisSolanaTrades', config?.api, config?.genesis, owner, page],
      queryFn: () => fetchOphisSolanaTrades(config?.api || '', solanaAddress(owner || ''), page * pageSize, pageSize),
      enabled: !!owner && !!config && page >= 0,
      retry: false,
      refetchOnWindowFocus: false,
    }
  }),
)

export const indexedOrderAtom = atomFamily((uid: string) =>
  atomWithQuery((get) => {
    const owner = get(solanaConnectionAtom)?.account.address
    const config = OPHIS_SOLANA_CONFIG
    return {
      queryKey: ['ophisSolanaReceiptOrder', config?.api, config?.genesis, owner, uid],
      enabled: !!config && !!owner,
      queryFn: async () => {
        const result = await fetchOphisSolanaOrder(config?.api || '', uid)
        if (result.owner !== owner) throw Error('Indexed order identity mismatch.')
        return result
      },
      staleTime: Infinity,
      retry: false,
    }
  }),
)

// Timestamp lookup sends only the finalized slot and is independent of signing and settlement.
export const blockTimeAtom = atomFamily((slot: number) =>
  atomWithQuery(() => ({
    queryKey: ['solanaMainnetBlockTime', slot],
    enabled: OPHIS_SOLANA_CONFIG?.chain === 'solana:mainnet' && Number.isSafeInteger(slot) && slot >= 0,
    queryFn: async () => {
      const response = await fetchWithTimeout('https://solana-rpc.publicnode.com', {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockTime', params: [slot] }),
      })
      if (!response.ok) throw Error('Block time unavailable.')
      const value: unknown = (await response.json()).result
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error('Invalid block time.')
      return value
    },
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  })),
)

export const orderDepositAtom = atomFamily((uid: string) =>
  atomWithQuery((get) => {
    const order = get(visibleNativeSolanaOrdersAtom).find((entry) => entry.uid === uid)
    const rpc = balanceEndpoint(OPHIS_SOLANA_CONFIG)
    return {
      queryKey: ['solanaOrderDeposit', order?.genesis, order?.owner, uid],
      enabled: !!rpc && !!order && !order.reclaimed,
      queryFn: async () => {
        if (!order || !rpc) throw Error('Order configuration unavailable.')
        const snapshot = await readOphisOrderAccount(
          rpc,
          order.genesis,
          solanaAddress(order.program),
          uid,
          solanaAddress(order.orderPda),
          'finalized',
        )
        return snapshot.lamports ?? null
      },
      retry: false,
      refetchOnWindowFocus: false,
    }
  }),
)
