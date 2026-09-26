import { isRejectRequestProviderError } from '@cowprotocol/common-utils'
import {
  COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
  COW_PROTOCOL_VAULT_RELAYER_ADDRESS,
  OrderSigningUtils,
  SigningScheme,
} from '@cowprotocol/cow-sdk'

import { orderBookApi } from 'cowSdk'
import { WBTC_ETHEREUM } from 'entities/cctp'
import {
  concatHex,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hashTypedData,
  toHex,
  type Hex,
  type WalletClient,
} from 'viem'

import { type BtcSwapQuote } from './btcSwapQuote.service'
import { parseBtcSwap, type BtcSwapPending } from './btcSwapState'
import { cctpClient } from './cctp.service'
import { CCTP_STORAGE_KEY, cctpStorage } from './cctpState'
import { assertCctpWallet } from './cctpWallet.service'

const relayer = COW_PROTOCOL_VAULT_RELAYER_ADDRESS[1]

export function assertBtcSwapQuote(quote: BtcSwapQuote): void {
  if (
    Date.now() < quote.quotedAt ||
    Date.now() - quote.quotedAt >= 60_000 ||
    quote.swap.orderToSign.validTo * 1000 <= Date.now()
  )
    throw new Error('Refresh the swap and bridge quote.')
}

export async function approveBtcSwap(
  wallet: WalletClient,
  quote: BtcSwapQuote,
  assertCurrent: () => void,
): Promise<void> {
  assertBtcSwapQuote(quote)
  const owner = quote.bridge.owner
  await assertCctpWallet(wallet, owner, 1)
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [relayer, BigInt(quote.swap.orderToSign.sellAmount)],
  })
  await cctpClient(1).call({ account: owner, to: WBTC_ETHEREUM, data })
  await assertCctpWallet(wallet, owner, 1)
  assertCurrent()
  const hash = await wallet.sendTransaction({
    account: owner,
    chain: cctpClient(1).chain,
    to: WBTC_ETHEREUM,
    data,
    value: 0n,
  })
  const receipt = await cctpClient(1).waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 10_000 })
  if (receipt.status !== 'success') throw new Error('WBTC approval reverted')
}

export async function readBtcSwapFunds(quote: BtcSwapQuote): Promise<{ approved: boolean; funded: boolean }> {
  const owner = quote.bridge.owner
  const [allowance, balance] = await Promise.all([
    cctpClient(1).readContract({
      address: WBTC_ETHEREUM,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, relayer],
    }),
    cctpClient(1).readContract({ address: WBTC_ETHEREUM, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  ])
  const amount = BigInt(quote.swap.orderToSign.sellAmount)
  return { approved: allowance >= amount, funded: balance >= amount }
}

export async function submitBtcSwap(
  wallet: WalletClient,
  quote: BtcSwapQuote,
  persist: (value: BtcSwapPending | null) => void,
  assertCurrent: () => void,
): Promise<void> {
  if (!navigator.locks) throw new Error('Please use a current browser to swap and bridge')
  await navigator.locks.request('ophisCctpBurn', { ifAvailable: true }, async (lock) => {
    if (!lock || (await cctpStorage.getItem(CCTP_STORAGE_KEY, null)))
      throw new Error('A swap or bridge is already pending. Resume it first.')
    const owner = quote.bridge.owner
    const order = quote.swap.orderToSign
    const funds = await readBtcSwapFunds(quote)
    if (!funds.approved || !funds.funded) throw new Error('WBTC balance or approval is insufficient')
    const codes = await Promise.all([1, 5042].map((chain) => cctpClient(chain).getCode({ address: owner })))
    if (codes.some((code) => code && code !== '0x'))
      throw new Error('This route currently supports personal wallets without smart-account code.')
    const { name, version } = await OrderSigningUtils.getDomain(1)
    const domain = { name, version, chainId: 1, verifyingContract: COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS[1] }
    const typedData = {
      domain,
      types: OrderSigningUtils.getEIP712Types(),
      primaryType: 'Order' as const,
      message: order,
    }
    const orderId = concatHex([hashTypedData(typedData), getAddress(owner) as Hex, toHex(order.validTo, { size: 4 })])
    await assertCctpWallet(wallet, owner, 1)
    assertBtcSwapQuote(quote)
    assertCurrent()
    const pending: BtcSwapPending = {
      type: 'wbtcToArc',
      owner,
      orderUid: orderId,
      sellAmount: order.sellAmount,
      minimumBuyAmount: order.buyAmount,
      validTo: order.validTo,
    }
    persist(pending)
    if (JSON.stringify(await cctpStorage.getItem(CCTP_STORAGE_KEY, null)) !== JSON.stringify(pending))
      throw new Error('Could not save swap recovery details. Nothing was signed.')
    const signature = await wallet.signTypedData({ account: owner, ...typedData }).catch((error: unknown) => {
      if (isRejectRequestProviderError(error)) persist(null)
      throw error
    })
    await assertCctpWallet(wallet, owner, 1)
    assertBtcSwapQuote(quote)
    assertCurrent()
    const submittedUid = await orderBookApi.sendOrder(
      {
        ...order,
        from: owner,
        signature,
        signingScheme: SigningScheme.EIP712,
        quoteId: quote.swap.quoteResponse.id,
        appData: quote.swap.appDataInfo.fullAppData,
        appDataHash: quote.swap.appDataInfo.appDataKeccak256,
      },
      { chainId: 1, env: 'prod' },
    )
    if (submittedUid.toLowerCase() !== orderId.toLowerCase())
      throw new Error('Unexpected order response. Keep this route open while its status is checked.')
  })
}

export async function updateBtcSwap(
  pending: BtcSwapPending,
  update: () => Promise<BtcSwapPending | null>,
  persist: (value: BtcSwapPending | null) => void,
): Promise<void> {
  if (!navigator.locks) throw new Error('Please use a current browser to resume the route')
  await navigator.locks.request('ophisCctpBurn', { ifAvailable: true }, async (lock) => {
    const saved = parseBtcSwap(await cctpStorage.getItem(CCTP_STORAGE_KEY, null))
    if (!lock || JSON.stringify(saved) !== JSON.stringify(pending))
      throw new Error('Saved route changed in another tab. Refresh before continuing.')
    persist(await update())
  })
}
