import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { messages as enMessages } from '../../locales/en-US.po'

import type { OtcDataState, OtcIndexedOrder, OtcOrder, OtcSnapshot } from 'ophis/otc'

export const MAKER = '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9'
export const OTHER = '0x2eDecb91091324e0138EBBBaEd48ce1B2A050428'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const ZAMM = '0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED'
export const NOW_MS = 1_755_010_800_000

i18n.loadAndActivate({ locale: 'en-US', messages: enMessages })

export function renderView(ui: Parameters<typeof render>[0]): ReturnType<typeof render> {
  return render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  )
}

function order(orderId: bigint, overrides: Partial<OtcOrder> = {}): OtcOrder {
  return {
    orderId,
    maker: MAKER,
    active: true,
    tokenA: WETH,
    amountA: 1_000_000_000_000_000_000n,
    tokenB: USDC,
    amountB: 4_000_000_000n,
    ...overrides,
  }
}

function indexedRow(orderId: bigint, overrides: Partial<OtcIndexedOrder> = {}): OtcIndexedOrder {
  return {
    ...order(orderId),
    createdAt: 1_755_000_000,
    createdTx: '0xc074a1fe0000000000000000000000000000000000000000000000000000000000004cad',
    taker: null,
    filledAt: null,
    filledTx: null,
    cancelledAt: null,
    cancelledTx: null,
    ...overrides,
  }
}

export function emptyState(status: OtcDataState['status']): OtcDataState {
  return { status, degradedReason: null, snapshot: null, enrichment: null, reconciliation: null, indexLagBlocks: null }
}

export function readyState(overrides: Partial<OtcDataState> = {}): OtcDataState {
  const orders = [
    order(3n, { tokenA: ZAMM, amountA: 100_000_000_000_000_000_000n, tokenB: WETH, amountB: 10n ** 18n }),
    order(2n),
    order(1n, { maker: OTHER, active: false }),
    order(0n, { active: false }),
  ]
  const snapshot: OtcSnapshot = {
    chainId: 1,
    blockNumber: 1_000n,
    blockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    nextOrderId: 4n,
    orders,
    truncated: false,
  }
  const indexed = [
    indexedRow(3n, { tokenA: ZAMM, amountA: 100_000_000_000_000_000_000n, tokenB: WETH, amountB: 10n ** 18n }),
    indexedRow(2n),
    indexedRow(1n, { maker: OTHER, active: false, filledAt: 1_755_100_000, taker: OTHER }),
    indexedRow(0n, { active: false, cancelledAt: 1_755_200_000 }),
  ]
  return {
    status: 'ready',
    degradedReason: null,
    snapshot,
    enrichment: { byOrderId: new Map(indexed.map((row) => [row.orderId.toString(), row])), indexedBlock: 999n },
    reconciliation: {
      verifiedIds: [0n, 1n, 2n, 3n],
      mismatches: [],
      missingOnchain: [],
      notIndexed: [],
      unknownIds: [],
      activeLagIds: [],
    },
    indexLagBlocks: 1n,
    ...overrides,
  }
}
