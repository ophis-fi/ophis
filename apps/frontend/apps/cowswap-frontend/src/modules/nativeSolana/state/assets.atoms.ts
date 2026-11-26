import { atom } from 'jotai'

import {
  type OphisWalletHolding,
  fetchOphisWalletHoldings,
  fetchOphisOrderSolReserve,
  fetchOphisWalletSwapCosts,
  OPHIS_LOCAL_WALLET_RPC,
  SOLANA_NATIVE_ASSET,
  formatOphisSolanaAmount,
  parseOphisSolanaAmount,
  solanaAddress,
} from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { atomWithQuery } from 'jotai-tanstack-query'

import { nativeSolanaFormAtom } from './trade.atoms'

import {
  balanceEndpoint,
  fetchMainnetCatalog,
  nativeAsset,
  networkAssets,
  walletAssets,
  walletHoldingsKey,
  walletMint,
} from '../services/assets.service'
import { privateAction, privateSettlementEnabled } from '../services/privateSettlement.service'
import { nativeSolanaContext } from '../services/trade.service'

export const solanaNetworkAssetsAtom = atomWithQuery(() => ({
  queryKey: ['solana-market-tokens', OPHIS_SOLANA_CONFIG?.genesis],
  queryFn: () => networkAssets(OPHIS_SOLANA_CONFIG),
  staleTime: 60_000,
  refetchOnWindowFocus: false,
  retry: false,
}))

const catalogQuery = {
  queryKey: ['solana-mainnet-coingecko-tokens'],
  queryFn: fetchMainnetCatalog,
  staleTime: 30 * 60_000,
  retry: false,
  refetchOnWindowFocus: false,
}
// Both observers share the same cache. The form can read cached metadata without starting a request.
export const solanaMainnetCatalogAtom = atomWithQuery(() => ({
  ...catalogQuery,
  enabled: OPHIS_SOLANA_CONFIG?.chain === 'solana:mainnet',
}))
export const solanaCachedCatalogAtom = atomWithQuery(() => ({ ...catalogQuery, enabled: false }))

export const solanaHoldingsAtom = atomWithQuery<OphisWalletHolding[]>((get) => {
  const owner = get(solanaConnectionAtom)?.account.address
  const config = OPHIS_SOLANA_CONFIG
  const rpc = balanceEndpoint(config)
  return {
    queryKey: walletHoldingsKey(config?.genesis, owner),
    enabled: !!owner && !!config && !!rpc,
    queryFn: () => {
      if (!config || !rpc || !owner) throw Error('Wallet balance service unavailable.')
      if (privateSettlementEnabled) {
        return privateAction<(Omit<OphisWalletHolding, 'atoms'> & { atoms: string })[]>('holdings', { owner }).then(
          (rows) => rows.map((row) => ({ ...row, atoms: BigInt(row.atoms) })),
        )
      }
      return fetchOphisWalletHoldings(rpc, config.genesis, solanaAddress(owner))
    },
    staleTime: 30_000,
    refetchOnWindowFocus: rpc === OPHIS_LOCAL_WALLET_RPC,
    refetchInterval: (query) =>
      rpc === OPHIS_LOCAL_WALLET_RPC &&
      query.state.status === 'success' &&
      query.state.data?.some((holding) => holding.mint === SOLANA_NATIVE_ASSET && holding.atoms === 0n)
        ? 5_000
        : false,
    refetchOnReconnect: false,
    retry: false,
  }
})

export const walletAssetListAtom = atom((get) =>
  walletAssets(
    get(solanaNetworkAssetsAtom).data ?? [nativeAsset],
    get(solanaHoldingsAtom).data ?? [],
    get(solanaCachedCatalogAtom).data,
  ),
)
export const walletHoldingsMapAtom = atom(
  (get) => new Map(get(solanaHoldingsAtom).data?.map((row) => [walletMint(row.mint), row])),
)
export const orderSolReserveAtom = atomWithQuery((get) => {
  const config = OPHIS_SOLANA_CONFIG
  const rpc = balanceEndpoint(config)
  const owner = get(solanaConnectionAtom)?.account.address
  const { sellMint, buyMint } = get(nativeSolanaFormAtom)
  return {
    queryKey: ['solana-order-reserve', config?.genesis, owner, sellMint === 'SOL', buyMint],
    enabled: !!(config && rpc && owner && buyMint && buyMint !== sellMint),
    queryFn: async () => {
      if (!config || !rpc || !owner) throw Error('Wallet balance service unavailable.')
      const context = await nativeSolanaContext(config)
      const args = [
        rpc,
        config.genesis,
        solanaAddress(owner),
        buyMint === 'SOL' ? SOLANA_NATIVE_ASSET : solanaAddress(buyMint),
        sellMint === 'SOL',
      ] as const
      return context.walletAtomic
        ? (await fetchOphisWalletSwapCosts(...args, 2)).reserve
        : fetchOphisOrderSolReserve(...args)
    },
    staleTime: 30_000,
    retry: false,
  }
})

function spendableAfterReserve(balance?: bigint, reserve?: bigint): bigint | undefined {
  if (balance === undefined || reserve === undefined) return undefined
  return balance > reserve ? balance - reserve : 0n
}

function holdingBalance(
  holding: OphisWalletHolding | undefined,
  known: boolean,
  native: boolean,
): {
  balance: string
  precision?: number
  atoms?: bigint
} {
  return {
    balance: holding ? formatOphisSolanaAmount(holding.atoms, holding.decimals) : '0',
    precision: holding?.decimals ?? (native ? 9 : undefined),
    atoms: known ? (holding?.atoms ?? 0n) : undefined,
  }
}

function extraSolNeeded(required?: bigint, balance?: bigint): bigint | undefined {
  return required !== undefined && balance !== undefined && required > balance ? required - balance : undefined
}

export const sellAmountStateAtom = atom((get) => {
  const form = get(nativeSolanaFormAtom)
  const balances = get(solanaHoldingsAtom)
  const holdings = get(walletHoldingsMapAtom)
  const holding = holdings.get(form.sellMint)
  const balanceKnown = !!balances.data && !balances.isError
  const native = form.sellMint === 'SOL'
  const { balance, precision, atoms } = holdingBalance(holding, balanceKnown, native)
  const estimate = get(orderSolReserveAtom)
  const solReserve = estimate.isError ? undefined : estimate.data
  const reserve = native ? solReserve : 0n
  const nativeBalance = holdings.get('SOL')?.atoms
  const solShortfall = !native && balanceKnown ? extraSolNeeded(solReserve, nativeBalance) : undefined
  const spendable = spendableAfterReserve(atoms, reserve)
  return {
    ...amountAvailability(form.amount, precision, atoms, reserve ?? 1n),
    solShortfall,
    estimatingTokenOrder: !native && estimate.isLoading,
    balanceKnown,
    balance,
    spendable,
    precision,
    reserve,
  }
})

function amountAvailability(
  text: string,
  decimals: number | undefined,
  balance: bigint | undefined,
  reserve: bigint,
): { valid: boolean; exceeds: boolean; needsSolForFees?: boolean } {
  if (decimals === undefined) {
    // A mint entered manually gets its actual precision when the quote is requested.
    const valid = positiveDecimal(text)
    return { valid, exceeds: valid && balance !== undefined }
  }
  try {
    const amount = parseOphisSolanaAmount(text, decimals)
    const exceeds = balance !== undefined && amount > balance
    const spendable = spendableAfterReserve(balance, reserve)
    const needsSolForFees = !exceeds && spendable !== undefined && amount > spendable
    return {
      valid: amount > 0n && !needsSolForFees,
      exceeds,
      needsSolForFees,
    }
  } catch {
    return { valid: false, exceeds: false }
  }
}

function positiveDecimal(text: string): boolean {
  return text.length <= 300 && /^\d+(?:\.\d*)?$/.test(text) && /[1-9]/.test(text)
}
