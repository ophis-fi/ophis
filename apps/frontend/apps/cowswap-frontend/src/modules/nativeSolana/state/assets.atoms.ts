import { atom } from 'jotai'

import {
  type OphisWalletHolding,
  fetchOphisWalletHoldings,
  OPHIS_LOCAL_WALLET_RPC,
  SOLANA_NATIVE_ASSET,
  formatOphisSolanaAmount,
  parseOphisSolanaAmount,
  solanaAddress,
} from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { atomWithQuery } from 'jotai-tanstack-query'

import { nativeSolanaFormAtom } from './trade.atoms'

import { balanceEndpoint, nativeAsset, networkAssets, walletAssets, walletHoldingsKey, walletMint } from '../services/assets.service'
import { privateAction, privateSettlementEnabled } from '../services/privateSettlement.service'

export const solanaNetworkAssetsAtom = atomWithQuery(() => ({
  queryKey: ['solana-market-tokens', OPHIS_SOLANA_CONFIG?.genesis],
  queryFn: () => networkAssets(OPHIS_SOLANA_CONFIG),
  staleTime: 60_000,
  refetchOnWindowFocus: false,
  retry: false,
}))

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
  walletAssets(get(solanaNetworkAssetsAtom).data ?? [nativeAsset], get(solanaHoldingsAtom).data ?? []),
)
export const walletHoldingsMapAtom = atom(
  (get) => new Map(get(solanaHoldingsAtom).data?.map((row) => [walletMint(row.mint), row])),
)
export const sellAmountStateAtom = atom((get) => {
  const form = get(nativeSolanaFormAtom)
  const balances = get(solanaHoldingsAtom)
  const holding = get(walletHoldingsMapAtom).get(form.sellMint)
  const balanceKnown = !!balances.data && !balances.isError
  const balance = holding ? formatOphisSolanaAmount(holding.atoms, holding.decimals) : '0'
  const native = form.sellMint === 'SOL'
  const precision = holding?.decimals ?? (native ? 9 : undefined)
  const atoms = balanceKnown ? (holding?.atoms ?? 0n) : undefined
  return { ...amountAvailability(form.amount, precision, atoms, native), balanceKnown, balance }
})

function amountAvailability(
  text: string,
  decimals: number | undefined,
  balance: bigint | undefined,
  native: boolean,
): { valid: boolean; exceeds: boolean; needsSolForFees?: boolean } {
  if (decimals === undefined) {
    // A mint entered manually gets its actual precision when the quote is requested.
    const valid = positiveDecimal(text)
    return { valid, exceeds: valid && balance !== undefined }
  }
  try {
    const amount = parseOphisSolanaAmount(text, decimals)
    const needsSolForFees = native && amount > 0n && amount === balance
    return {
      valid: amount > 0n && !needsSolForFees,
      exceeds: balance !== undefined && amount > balance,
      needsSolForFees,
    }
  } catch {
    return { valid: false, exceeds: false }
  }
}

function positiveDecimal(text: string): boolean {
  return text.length <= 300 && /^\d+(?:\.\d*)?$/.test(text) && /[1-9]/.test(text)
}
