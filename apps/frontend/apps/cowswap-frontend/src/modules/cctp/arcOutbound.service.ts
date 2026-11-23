import {
  ACROSS_V5_ADAPTER,
  ACROSS_V5_API,
  ARC_CHAIN_ID,
  ARC_USDC_ADDRESS,
  RELAY_DEPOSIT,
  RELAY_ENABLED,
  RelayApi,
  acrossV5Api,
  checkAcrossV5Deposit,
  getRpcProvider,
  relayDepository,
  relayQuote,
  type AcrossV5Quote,
} from '@cowprotocol/common-const'
import { OrderKind, type SupportedChainId } from '@cowprotocol/cow-sdk'
import { type QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { arcOutboundToken, cctpNetwork } from 'entities/cctp'
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex, type WalletClient } from 'viem'

import { cctpClient } from './cctp.service'
import { assertCctpWallet } from './cctpWallet.service'

export type ArcBridgeProvider = 'Across' | 'Relay'
export interface ArcDeposit {
  provider: ArcBridgeProvider
  owner: Address
  destination: number
  amount: bigint
  expected: bigint
  minimum: bigint
  expires: number
  id: Hex
  spender: Address
  data: Hex
}

export async function quoteArcDeposit(
  provider: ArcBridgeProvider,
  owner: Address,
  destination: number,
  amount: bigint,
): Promise<ArcDeposit> {
  const token = arcOutboundToken(ARC_CHAIN_ID, destination)
  if (!token || amount <= 0n) throw new Error('Select Arc USDC, a supported destination and a positive amount.')
  const common = { provider, owner, amount, destination }
  if (provider === 'Across') {
    const request = {
      originChainId: ARC_CHAIN_ID,
      destinationChainId: destination,
      depositor: owner,
      recipient: owner,
      inputToken: ARC_USDC_ADDRESS,
      outputToken: token.address,
      amount: String(amount),
    }
    const quote = (await acrossV5Api(ACROSS_V5_API, 'quote', request)) as AcrossV5Quote
    checkAcrossV5Deposit(quote, request)
    return {
      ...common,
      expected: BigInt(quote.expectedOutput),
      minimum: BigInt(quote.minimumOutput),
      expires: quote.expiresAt,
      id: quote.orderId as Hex,
      spender: getAddress(ACROSS_V5_ADAPTER),
      data: quote.depositData as Hex,
    }
  }
  if (!RELAY_ENABLED) throw new Error('Relay is unavailable.')
  const request: QuoteBridgeRequest = {
    kind: OrderKind.SELL,
    appCode: 'ophis',
    account: getAddress(owner) as Hex,
    sellTokenChainId: ARC_CHAIN_ID,
    sellTokenAddress: ARC_USDC_ADDRESS,
    sellTokenDecimals: 6,
    buyTokenChainId: token.chainId,
    buyTokenAddress: token.address,
    buyTokenDecimals: 6,
    amount,
  }
  const quote = await relayQuote(new RelayApi(), request, owner)
  return {
    ...common,
    expected: quote.amountsAndCosts.afterFee.buyAmount,
    minimum: quote.amountsAndCosts.afterSlippage.buyAmount,
    expires: quote.depositUntil,
    id: quote.relay.requestId as Hex,
    spender: getAddress(relayDepository(ARC_CHAIN_ID)),
    data: RELAY_DEPOSIT.encodeFunctionData('depositErc20', [
      owner,
      ARC_USDC_ADDRESS,
      String(amount),
      quote.relay.protocol.v2.orderId,
    ]) as Hex,
  }
}

export function arcAllowance(quote: ArcDeposit): Promise<bigint> {
  return cctpClient(ARC_CHAIN_ID).readContract({
    address: ARC_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [quote.owner, quote.spender],
  })
}

export async function sendArcDeposit(
  wallet: WalletClient,
  quote: ArcDeposit,
  approve: boolean,
  assertCurrent: () => void,
  beforeDeposit: (nonce: number) => void,
): Promise<Hex> {
  const client = cctpClient(ARC_CHAIN_ID)
  const account = quote.owner
  await assertCctpWallet(wallet, account, ARC_CHAIN_ID)
  const [allowed, sourceCode, destinationCode] = await Promise.all([
    arcAllowance(quote),
    client.getCode({ address: account }),
    getRpcProvider(quote.destination as SupportedChainId).getCode(account),
  ])
  if ([sourceCode, destinationCode].some((code) => code && code !== '0x'))
    throw new Error('This route requires a personal wallet on both networks.')
  const needsApproval = allowed < quote.amount
  if (approve !== needsApproval) throw new Error('Allowance changed. Review a fresh quote.')
  const to = approve ? ARC_USDC_ADDRESS : quote.spender
  const data = approve
    ? encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [quote.spender, quote.amount] })
    : quote.data
  const [gas, price, balance, nonce] = await Promise.all([
    client.estimateGas({ account, to, data }),
    client.getGasPrice(),
    client.getBalance({ address: account }),
    client.getTransactionCount({ address: account, blockTag: 'pending' }),
  ])
  // Arc ERC-20 USDC and gas share a balance, with six and eighteen decimals respectively.
  if (balance < quote.amount * 10n ** 12n + 2n * price * gas) throw new Error('Leave enough USDC on Arc for gas.')
  await assertCctpWallet(wallet, account, ARC_CHAIN_ID)
  assertCurrent()
  if (Date.now() / 1000 + 15 >= quote.expires) throw new Error('This quote expired. Review a fresh quote.')
  if (!approve) beforeDeposit(nonce)
  return wallet.sendTransaction({ account, chain: cctpNetwork(ARC_CHAIN_ID).chain, to, data, value: 0n, nonce })
}
