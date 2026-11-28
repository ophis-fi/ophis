import { atom } from 'jotai'

import {
  type OphisWalletHolding,
  fetchOphisWalletHoldings,
  fetchOphisOrderSolReserve,
  fetchOphisWalletSwapCosts,
  getOphisNativeSellFeeCap,
  OPHIS_LOCAL_WALLET_RPC,
  OPHIS_MAINNET_PROGRAM,
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
  formatOphisSolanaAmount,
  parseOphisSolanaAmount,
  solanaAddress,
} from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { atomWithQuery } from 'jotai-tanstack-query'

import { nativeSolanaFormAtom, nativeSolanaReviewAtom } from './trade.atoms'

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
import { minimumSolanaBuyAmount, nativeSolanaContext, type NativeSolanaReview } from '../services/trade.service'

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

function atomicReserve(costs: Awaited<ReturnType<typeof fetchOphisWalletSwapCosts>>): {
  fixed: bigint
  returnedBeforeFee: bigint
  walletAtomic: boolean
} {
  return { fixed: costs.reserve, returnedBeforeFee: costs.nativeWrapRent + costs.solverInputRent, walletAtomic: true }
}

export const orderSolReserveAtom = atomWithQuery((get) => {
  const config = OPHIS_SOLANA_CONFIG
  const rpc = balanceEndpoint(config)
  const owner = get(solanaConnectionAtom)?.account.address
  const { sellMint, buyMint } = get(nativeSolanaFormAtom)
  const solver =
    config?.chain === 'solana:mainnet' && config.program === OPHIS_MAINNET_PROGRAM
      ? process.env.REACT_APP_OPHIS_SOLANA_MARKET_SOLVER
      : undefined
  return {
    queryKey: ['solana-order-reserve', config?.genesis, owner, sellMint, buyMint, solver],
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
      if (!context.walletAtomic)
        return { fixed: await fetchOphisOrderSolReserve(...args), returnedBeforeFee: 0n, walletAtomic: false }
      const solverInput =
        solver && sellMint
          ? { solver: solanaAddress(solver), sellMint: sellMint === 'SOL' ? WRAPPED_SOL_MINT : solanaAddress(sellMint) }
          : undefined
      return atomicReserve(await fetchOphisWalletSwapCosts(...args, 2, solverInput))
    },
    staleTime: 30_000,
    retry: false,
  }
})

function spendableAfterReserve(balance?: bigint, reserve?: bigint): bigint | undefined {
  if (balance === undefined || reserve === undefined) return undefined
  return balance > reserve ? balance - reserve : 0n
}

function remainingFee(cap: bigint, credited: bigint): bigint {
  return cap > credited ? cap - credited : 0n
}

function maxNativeSell(available: bigint, buy: ReturnType<typeof solanaAddress>, returnedBeforeFee: bigint): bigint {
  // The cap scales with the amount sold. Deposits that return before collection can pay it.
  let lower = 0n
  let upper = available
  while (lower < upper) {
    const amount = (lower + upper + 1n) / 2n
    if (amount + remainingFee(getOphisNativeSellFeeCap(amount, buy), returnedBeforeFee) <= available) lower = amount
    else upper = amount - 1n
  }
  return lower
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

function quotedNativeFees(
  review: NativeSolanaReview | null,
  returnedBeforeFee: bigint,
): { cap?: bigint; upfront: bigint } {
  const terms = review?.quote.quote.nativeProtocolFee
  if (!review || !terms) return { upfront: 0n }
  const cap = BigInt(terms.maxLamports)
  // SOL proceeds arrive before Ophis collects its fee. Wrapped SOL stays in the token account.
  const proceeds = review.form.buyMint === 'SOL' ? minimumSolanaBuyAmount(review) : 0n
  return { cap, upfront: remainingFee(cap, proceeds + returnedBeforeFee) }
}

interface SellBudget {
  spendable?: bigint
  maximumForEnteredAmount?: bigint
  reserve?: bigint
  solShortfall?: bigint
}

function nativeSellBudget(
  balance: bigint | undefined,
  fixed: bigint | undefined,
  buyWithNativeFee: string | undefined,
  quotedCap: bigint | undefined,
  returnedBeforeFee: bigint,
): SellBudget {
  if (fixed === undefined || balance === undefined)
    return { reserve: fixed, maximumForEnteredAmount: spendableAfterReserve(balance, 1n) }
  const available = balance > fixed ? balance - fixed : 0n
  const spendable = buyWithNativeFee
    ? maxNativeSell(available, solanaAddress(buyWithNativeFee), returnedBeforeFee)
    : available
  const reserve = fixed + (quotedCap === undefined ? available - spendable : remainingFee(quotedCap, returnedBeforeFee))
  return { reserve, spendable, maximumForEnteredAmount: spendableAfterReserve(balance, reserve) }
}

function tokenSellBudget(
  tokenBalance: bigint | undefined,
  nativeBalance: bigint | undefined,
  fixed: bigint | undefined,
  upfrontFee: bigint,
): SellBudget {
  const required = fixed === undefined ? undefined : fixed + upfrontFee
  return {
    spendable: tokenBalance,
    maximumForEnteredAmount: tokenBalance,
    solShortfall: extraSolNeeded(required, nativeBalance),
  }
}

const inputBalancesAtom = atom((get) => {
  const { sellMint } = get(nativeSolanaFormAtom)
  const balances = get(solanaHoldingsAtom)
  const holdings = get(walletHoldingsMapAtom)
  const balanceKnown = !!balances.data && !balances.isError
  return {
    sale: holdingBalance(holdings.get(sellMint), balanceKnown, sellMint === 'SOL'),
    nativeBalance: holdingBalance(holdings.get('SOL'), balanceKnown, true).atoms,
    balanceKnown,
  }
})

const currentReserveAtom = atom((get) => {
  const prepared = get(nativeSolanaReviewAtom)?.atomic
  if (prepared) return atomicReserve(prepared.costs)
  const estimate = get(orderSolReserveAtom)
  return estimate.isError ? undefined : estimate.data
})

export const sellAmountStateAtom = atom((get) => {
  const form = get(nativeSolanaFormAtom)
  const { sale, nativeBalance, balanceKnown } = get(inputBalancesAtom)
  const native = form.sellMint === 'SOL'
  const estimate = get(orderSolReserveAtom)
  const review = get(nativeSolanaReviewAtom)
  const estimated = get(currentReserveAtom)
  const fixed = estimated?.fixed
  const returnedBeforeFee = estimated?.returnedBeforeFee ?? 0n
  const fee = quotedNativeFees(review, returnedBeforeFee)
  const buyWithNativeFee = estimated?.walletAtomic ? form.buyMint : undefined
  const budget = native
    ? nativeSellBudget(sale.atoms, fixed, buyWithNativeFee, fee.cap, returnedBeforeFee)
    : tokenSellBudget(sale.atoms, nativeBalance, fixed, fee.upfront)
  return {
    ...amountAvailability(form.amount, sale.precision, sale.atoms, budget.maximumForEnteredAmount),
    ...budget,
    balance: sale.balance,
    precision: sale.precision,
    balanceKnown,
    estimatingTokenOrder: !native && estimate.isLoading,
  }
})

function amountAvailability(
  text: string,
  decimals: number | undefined,
  balance: bigint | undefined,
  spendable: bigint | undefined,
): { valid: boolean; exceeds: boolean; needsSolForFees?: boolean } {
  if (decimals === undefined) {
    // A mint entered manually gets its actual precision when the quote is requested.
    const valid = positiveDecimal(text)
    return { valid, exceeds: valid && balance !== undefined }
  }
  try {
    const amount = parseOphisSolanaAmount(text, decimals)
    const exceeds = balance !== undefined && amount > balance
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
