import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { defaultAbiCoder, Interface } from '@ethersproject/abi'
import { keccak256 } from '@ethersproject/keccak256'
import { JsonRpcProvider, TransactionRequest, Web3Provider } from '@ethersproject/providers'

import { GNOSIS_MPS, GNOSIS_ROUTER, MPS_PROCESSOR } from './gnosis.service'
import { directChainId, DirectQuote, MPS, ROUTER, USDC } from './router.service'

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const tokenAbi = new Interface([
  'function allowance(address,address) view returns(uint256)',
  'function balanceOf(address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
])
const permitAbi = new Interface([
  'function allowance(address,address,address) view returns(uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address,address,uint160,uint48)',
])

function slot(address: string, parent: string | number): string {
  return keccak256(defaultAbiCoder.encode(['address', 'uint256'], [address, parent]))
}
function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`
}

/** Read-only quote simulation. Execution always uses the wallet's real state. */
export function simulationState(account: string, inputToken?: string): Record<string, unknown> {
  const funding = { [account]: { balance: '0x3635c9adc5dea00000' } }
  if (!inputToken) return funding
  if (areAddressesEqual(inputToken, GNOSIS_MPS)) {
    // ShareBridgeToken stores balances/allowances in Processor._tokens (slot 152).
    // Confirmed against the deployed token getters with read-only state overrides.
    const base = BigInt(slot(GNOSIS_MPS, 152))
    return {
      ...funding,
      [MPS_PROCESSOR]: {
        stateDiff: {
          [slot(account, (base + 3n).toString())]: word(10n ** 18n),
          [slot(GNOSIS_ROUTER, slot(account, (base + 4n).toString()))]: word(10n ** 18n),
        },
      },
    }
  }
  if (![USDC, MPS].some((token) => areAddressesEqual(inputToken, token))) throw new Error('Unsupported direct input')
  const mps = areAddressesEqual(inputToken, MPS)
  // Ethereum balance/allowance slots, verified against each deployed contract on a fork.
  return {
    ...funding,
    [inputToken]: {
      stateDiff: {
        [slot(account, mps ? 0 : 9)]: word(10n ** 18n),
        [slot(PERMIT2, slot(account, mps ? 2 : 10))]: word(10n ** 18n),
      },
    },
    // Permit2 AllowanceTransfer: owner -> token -> spender; uint160 amount + uint48 expiry + uint48 nonce.
    [PERMIT2]: {
      stateDiff: {
        [slot(ROUTER, slot(inputToken, slot(account, 1)))]: word((10n ** 18n) | (((1n << 48n) - 1n) << 160n)),
      },
    },
  }
}

export async function getInputApprovals(
  provider: JsonRpcProvider,
  account: string,
  amount: bigint,
  deadline: number,
  inputToken = USDC,
  chainId = 1,
): Promise<TransactionRequest[]> {
  if ([chainId === 100, areAddressesEqual(inputToken, GNOSIS_MPS)].every(Boolean)) {
    const allowed = await provider.call({
      to: inputToken,
      data: tokenAbi.encodeFunctionData('allowance', [account, GNOSIS_ROUTER]),
    })
    return BigInt(allowed) >= amount
      ? []
      : [{ to: inputToken, data: tokenAbi.encodeFunctionData('approve', [GNOSIS_ROUTER, amount]) }]
  }
  if (chainId !== 1 || ![USDC, MPS].some((token) => areAddressesEqual(inputToken, token)))
    throw new Error('Unsupported direct input')
  const [tokenRaw, permitRaw] = await Promise.all([
    provider.call({ to: inputToken, data: tokenAbi.encodeFunctionData('allowance', [account, PERMIT2]) }),
    provider.call({ to: PERMIT2, data: permitAbi.encodeFunctionData('allowance', [account, inputToken, ROUTER]) }),
  ])
  const [allowed, expiration] = permitAbi.decodeFunctionResult('allowance', permitRaw)
  const txs: TransactionRequest[] = []
  if (BigInt(tokenRaw) < amount)
    txs.push({ to: inputToken, data: tokenAbi.encodeFunctionData('approve', [PERMIT2, amount]) })
  if (BigInt(allowed.toString()) < amount || Number(expiration) < deadline) {
    txs.push({ to: PERMIT2, data: permitAbi.encodeFunctionData('approve', [inputToken, ROUTER, amount, deadline]) })
  }
  return txs
}

export async function approveDirectInput(
  wallet: Web3Provider,
  rpc: JsonRpcProvider,
  quote: DirectQuote,
  isCurrent: () => boolean,
): Promise<void> {
  if (!quote.inputToken) throw new Error('Token approval not required')
  const txs = await getInputApprovals(
    rpc,
    quote.account,
    quote.budget,
    quote.expiresAt + 1800,
    quote.inputToken,
    directChainId(quote),
  )
  for (const tx of txs) {
    const account = await wallet.getSigner().getAddress()
    const chain = await wallet.send('eth_chainId', [])
    if (!isCurrent() || Number(chain) !== directChainId(quote) || !areAddressesEqual(account, quote.account)) {
      throw new Error('Wallet or quote changed. Review again.')
    }
    const sent = await wallet
      .getSigner()
      .sendTransaction({ ...tx, from: quote.account, chainId: directChainId(quote), value: 0 })
    const receipt = await sent.wait()
    if (receipt.status !== 1) throw new Error('Approval failed')
  }
}

export async function getInputBalance(provider: JsonRpcProvider, quote: DirectQuote): Promise<bigint> {
  if (!quote.inputToken) return BigInt((await provider.getBalance(quote.account)).toString())
  return BigInt(
    await provider.call({ to: quote.inputToken, data: tokenAbi.encodeFunctionData('balanceOf', [quote.account]) }),
  )
}
