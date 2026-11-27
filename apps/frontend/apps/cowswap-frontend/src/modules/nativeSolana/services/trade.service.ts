import {
  fetchOphisSolanaChainContext,
  fetchOphisSolanaMint,
  verifyOphisMintMetadata,
  readOphisSellAllowance,
  checkedQuoteAppData,
  fetchOphisSolanaQuote,
  OPHIS_LOCAL_WALLET_RPC,
  OphisSolanaHttpError,
  ophisSolanaWalletSigner,
  parseOphisSolanaAmount,
  prepareOphisSolanaOrderFromQuote,
  prepareOphisWalletAtomicSwap,
  previewOphisLocalOrder,
  solanaAddress,
  SOLANA_NATIVE_ASSET,
  TOKEN_PROGRAM_ADDRESS,
  type OphisSolanaMintMetadata,
  type OphisSolanaQuote,
} from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, type OphisSolanaConfig, type SolanaConnection } from 'entities/solana'

import { balanceEndpoint } from './assets.service'

export interface NativeSolanaForm {
  sellMint: string
  buyMint: string
  amount: string
  slippageBps: number
}

export interface NativeSolanaReview {
  quote: OphisSolanaQuote
  sell: OphisSolanaMintMetadata
  buy: OphisSolanaMintMetadata
  form: NativeSolanaForm
  connection: SolanaConnection
  allowance?: Awaited<ReturnType<typeof readOphisSellAllowance>>
  atomic?: Awaited<ReturnType<typeof prepareOphisWalletAtomicSwap>>
  solAfterOrder?: bigint
}

export function minimumSolanaBuyAmount(review: NativeSolanaReview): bigint {
  return (BigInt(review.quote.quote.buyAmount) * BigInt(10_000 - review.form.slippageBps)) / 10_000n
}

export function prepareReviewedSolanaOrder(
  config: OphisSolanaConfig,
  review: NativeSolanaReview,
): ReturnType<typeof prepareOphisSolanaOrderFromQuote> {
  return prepareOphisSolanaOrderFromQuote(walletOrderInput(config, review))
}

function walletOrderInput(
  config: OphisSolanaConfig,
  review: NativeSolanaReview,
): Parameters<typeof prepareOphisSolanaOrderFromQuote>[0] {
  return {
    programAddress: config.program,
    owner: ophisSolanaWalletSigner(review.connection.account),
    quote: review.quote,
    sellProgram: review.sell.tokenProgram,
    buyProgram: review.buy.address === SOLANA_NATIVE_ASSET ? undefined : review.buy.tokenProgram,
    sellFromNativeSol: review.sell.address === SOLANA_NATIVE_ASSET,
    slippageBps: review.form.slippageBps,
  }
}

async function mintMetadata(api: string, value: string): Promise<OphisSolanaMintMetadata> {
  const mint = value.trim() === 'SOL' ? SOLANA_NATIVE_ASSET : solanaAddress(value.trim())
  return mint === SOLANA_NATIVE_ASSET
    ? { address: mint, tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 9, extensions: [] }
    : fetchOphisSolanaMint(api, mint)
}

export async function nativeSolanaContext(
  config: OphisSolanaConfig,
): Promise<Awaited<ReturnType<typeof fetchOphisSolanaChainContext>>> {
  const context = await fetchOphisSolanaChainContext(config.api)
  if (context.programAddress !== config.program || context.genesisHash !== config.genesis)
    throw Error('The trading service does not match the configured Ophis deployment.')
  return context
}

function backpackRpcForAccount(address: string): string | undefined {
  const injected = window as Window & {
    backpack?: { solana?: { publicKey?: { toBase58(): string }; connection?: { rpcEndpoint?: string } } }
  }
  const provider = injected.backpack?.solana
  return provider?.publicKey?.toBase58() === address ? provider?.connection?.rpcEndpoint : undefined
}

export function checkLocalBackpackRpc(config: OphisSolanaConfig, connection: SolanaConnection): void {
  if (config.chain !== 'solana:localnet' || connection.wallet.name !== 'Backpack') return
  const endpoint = backpackRpcForAccount(connection.account.address)
  if (!endpoint) return
  const url = new URL(endpoint)
  if (['localhost', '[::1]'].includes(url.hostname)) url.hostname = '127.0.0.1'
  if (url.href !== new URL(OPHIS_LOCAL_WALLET_RPC).href)
    throw Error(
      `Backpack is using a different RPC. In Backpack, open Solana → RPC Connection → Custom, enter ${OPHIS_LOCAL_WALLET_RPC}, then reconnect to this preview.`,
    )
}

export async function loadNativeSolanaQuote(
  config: OphisSolanaConfig,
  connection: SolanaConnection,
  form: NativeSolanaForm,
  signal?: AbortSignal,
): Promise<NativeSolanaReview> {
  const context = await nativeSolanaContext(config)
  signal?.throwIfAborted()
  const [sell, buy] = await Promise.all([
    mintMetadata(config.api, form.sellMint),
    mintMetadata(config.api, form.buyMint),
  ])
  if (sell.address === buy.address) throw Error('Choose two different tokens.')
  const rpc = balanceEndpoint(config)
  if (!rpc) throw Error('Wallet balance service unavailable.')
  signal?.throwIfAborted()
  const [, allowance] = await Promise.all([
    verifyOphisMintMetadata(rpc, config.genesis, [sell, buy]),
    context.walletAtomic && sell.address === SOLANA_NATIVE_ASSET
      ? null
      : readOphisSellAllowance(rpc, config.genesis, solanaAddress(connection.account.address), sell),
  ])
  signal?.throwIfAborted()
  const quote = await fetchOphisSolanaQuote(config.api, {
    from: solanaAddress(connection.account.address),
    ...(context.walletAtomic && { executionMode: 'walletAtomic' as const, slippageBps: form.slippageBps }),
    walletCreatesBuyTokenAccount: true,
    sellToken: sell.address,
    buyToken: buy.address,
    side: { kind: 'sell', sellAmountBeforeFee: parseOphisSolanaAmount(form.amount, sell.decimals) },
    validFor: 1800,
    priceQuality: 'verified',
  })
  if (!quote.verified) throw Error('An executable quote could not be verified. Request a new quote.')
  checkedQuoteAppData(config.program, quote.quote)
  const review: NativeSolanaReview = { quote, sell, buy, form, connection, allowance }
  await prepareWalletReview(config, review, context, rpc, signal)
  return review
}

async function prepareWalletReview(
  config: OphisSolanaConfig,
  review: NativeSolanaReview,
  context: Awaited<ReturnType<typeof nativeSolanaContext>>,
  rpc: string,
  signal?: AbortSignal,
): Promise<void> {
  if (context.walletAtomic) {
    if (signal) signal.throwIfAborted()
    review.atomic = await prepareOphisWalletAtomicSwap({
      ...walletOrderInput(config, review),
      rpc,
      api: config.api,
      genesis: config.genesis,
    })
  } else if (config.chain === 'solana:localnet') {
    const order = await prepareReviewedSolanaOrder(config, review)
    review.solAfterOrder = await previewOphisLocalOrder({
      instructions: order.instructions,
      payer: order.payer,
      programAddress: config.program,
      expectedGenesisHash: config.genesis,
      context,
    })
  }
}

const invalidMintMessage = 'This mint is unavailable for swaps. Check the Solana mint address.'
const protocolErrorMessages: Record<string, string | undefined> = {
  MarketQuoteUnavailable: 'This route is no longer available at the quoted price. Get a fresh quote.',
  SettlementPaused: 'New swaps are paused. You can still cancel an open order or reclaim its rent.',
  NoLiquidity: 'Ophis found no route for this pair and amount. Try a different amount or token.',
  VerifiedExactInputRequired:
    'Ophis could not verify a route for this swap. Your order has not been placed. Get a fresh quote.',
  SellAmountDoesNotCoverFee: 'The quoted amount is too small to cover the cost of this swap.',
  NativeFeePriceUnavailable: 'Ophis could not price its fee in SOL for this swap. Try a different amount or token.',
  InsufficientSolForFees: 'Your wallet needs more SOL for swap fees and deposits.',
  FeeQuoteUnavailable: 'Ophis could not verify the costs for this pair. Request a fresh quote or choose another pair.',
  InvalidMint: invalidMintMessage,
  MintNotFound: invalidMintMessage,
  UnknownMint: invalidMintMessage,
  UnsupportedMint: invalidMintMessage,
  UnsupportedToken: 'This token’s transfer rules prevent Ophis from settling this swap.',
  PrivateWallet: 'For this private test, connect the authorized Backpack account (63ox…irnA).',
  ChainUnavailable: 'Solana chain data is temporarily unavailable. Request a fresh quote in a moment.',
  PrivateBudget: 'The private RPC test budget is low. New orders are paused.',
  PrivateSolverRent:
    'The Ophis solver needs more SOL for account rent and settlement fees. Your swap has not been placed.',
  PrivateSolverFunding:
    'Review solver funding in Backpack first. Once the 0.003 SOL transfer confirms, get a fresh quote.',
}

function protocolErrorMessage(error: unknown): string | undefined {
  if (error instanceof OphisSolanaHttpError && error.errorType) return protocolErrorMessages[error.errorType]
  return undefined
}

function errorText(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string')
    return error.message
  return typeof error === 'string' ? error : ''
}

export function isMissingBlockhashError(error: unknown): boolean {
  return /blockhash\s*not\s*found/i.test(errorText(error))
}

export function nativeSolanaErrorMessage(error: unknown): string {
  if (error instanceof OphisSolanaHttpError && error.status === 429) return 'Ophis is busy. Try again in a moment.'
  const protocolMessage = protocolErrorMessage(error)
  if (protocolMessage) return protocolMessage
  const message = errorText(error) || 'The request did not complete. Check your wallet and order status.'
  if (OPHIS_SOLANA_CONFIG?.chain !== 'solana:localnet') return message
  if (isMissingBlockhashError(error))
    return `The blockhash was unavailable during simulation. Check that your wallet uses the local RPC (${OPHIS_LOCAL_WALLET_RPC}), then request a fresh quote and approve it again.`
  if (/^transaction (?:simulation failed|failed simulation)\.?$/i.test(message))
    return `Wallet simulation failed. Deny the prompt. Check the wallet’s Solana RPC (${OPHIS_LOCAL_WALLET_RPC}) before requesting a fresh quote.`
  return message
}
