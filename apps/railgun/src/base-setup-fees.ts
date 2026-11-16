import { accessListify, authorizationify, getAddress, getBytes, Interface, isHexString, toQuantity, Transaction, verifyAuthorization, ZeroAddress,
  type JsonRpcProvider, type TransactionRequest } from 'ethers'

const ORACLE = '0x420000000000000000000000000000000000000F'
const ABI = new Interface(['function getL1FeeUpperBound(uint256) view returns (uint256)',
  'function getOperatorFee(uint256) view returns (uint256)'])
export const BASE_SETUP_MAX_FEE_PER_GAS = 100_000_000n
export const BASE_SETUP_MAX_FUNDING = 10_000_000_000_000n
const REFUND_MAX_GAS = 100_000n
type FeeProvider = Pick<JsonRpcProvider, 'getNetwork' | 'getBlock' | 'getFeeData' | 'send'>
export interface BaseSetupFeeQuote {
  createdAt: number; blockNumber: number; blockHash: string; unsignedHash: string
  gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string
  executionMaximum: string; l1FeeEstimate: string; operatorFeeEstimate: string
  /** Buffered funding allocation; it does not guarantee a maximum inclusion fee. */
  maximumNetworkFee: string; feeBound: 'estimate-only'
}
function check(value: unknown): asserts value { if (!value) throw new Error('Invalid Base setup fee estimate.') }

async function quote(provider: FeeProvider,
  request: TransactionRequest, refund: boolean): Promise<BaseSetupFeeQuote> {
  check((await provider.getNetwork()).chainId === 8453n)
  const head = await provider.getBlock('latest'), createdAt = Date.now()
  check(head && isHexString(head.hash, 32) && Number.isSafeInteger(head.number) && head.number > 0 &&
    Number.isSafeInteger(head.timestamp) && Math.abs(createdAt - head.timestamp * 1000) <= 45_000)
  check(typeof request.from === 'string' && typeof request.to === 'string' && request.data === '0x' &&
    request.chainId != null && BigInt(request.chainId) === 8453n && Number.isSafeInteger(request.nonce) && request.nonce! >= 0 &&
    request.value != null && BigInt(request.value) >= 0n && BigInt(request.value) <= BASE_SETUP_MAX_FUNDING &&
    request.gasPrice == null && (request.accessList == null || accessListify(request.accessList).length === 0))
  const from = getAddress(request.from), to = getAddress(request.to)
  check(from !== ZeroAddress)
  const retainedFees = request.maxFeePerGas != null || request.maxPriorityFeePerGas != null
  const fees = retainedFees ? request : await provider.getFeeData()
  check(fees.maxFeePerGas != null && fees.maxPriorityFeePerGas != null)
  const maxFeePerGas = BigInt(fees.maxFeePerGas), maxPriorityFeePerGas = BigInt(fees.maxPriorityFeePerGas)
  check(maxFeePerGas > 0n && maxFeePerGas <= BASE_SETUP_MAX_FEE_PER_GAS && maxPriorityFeePerGas > 0n && maxPriorityFeePerGas <= maxFeePerGas)
  let gasLimit: bigint
  if (refund) {
    check(request.type === 2 && !request.authorizationList?.length && to !== ZeroAddress && to !== from)
    // Core owns archived account/payer, recipient code, phase, balance and nonce checks.
    // Ethers estimateGas drops TransactionRequest.blockTag; send the selector explicitly.
    const rawEstimate: unknown = await provider.send('eth_estimateGas', [{ from, to, value: toQuantity(request.value), data: '0x',
      type: '0x2', chainId: '0x2105', nonce: toQuantity(request.nonce!), maxFeePerGas: toQuantity(maxFeePerGas),
      maxPriorityFeePerGas: toQuantity(maxPriorityFeePerGas) }, toQuantity(head.number)])
    check(typeof rawEstimate === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(rawEstimate))
    const estimate = BigInt(rawEstimate)
    check(estimate >= 21_000n && estimate <= REFUND_MAX_GAS)
    gasLimit = request.gasLimit == null ? (estimate * 120n + 99n) / 100n : BigInt(request.gasLimit)
    check(gasLimit >= estimate && gasLimit <= REFUND_MAX_GAS)
  } else {
    check(request.type === 4 && request.nonce === 0 && to === ZeroAddress && BigInt(request.value) === 0n &&
      request.gasLimit != null && BigInt(request.gasLimit) === 46_000n && request.authorizationList?.length === 1)
    gasLimit = 46_000n
  }
  const tx = Transaction.from({ type: refund ? 2 : 4, chainId: 8453, nonce: request.nonce, to, value: request.value,
    data: '0x', gasLimit, maxFeePerGas, maxPriorityFeePerGas, accessList: [],
    ...(refund ? {} : { authorizationList: request.authorizationList!.map(authorizationify) }) })
  if (!refund) {
    const auth = tx.authorizationList![0]
    check(auth.chainId === 8453n && auth.nonce === 1n && auth.address !== ZeroAddress &&
      getAddress(verifyAuthorization(auth, auth.signature)) === from)
  }
  // GPO already adds the outer signature allowance. Only byte length/gas are disclosed.
  // Its documented 99.99% size estimate is NOT a consensus cap, even with this buffer.
  // https://github.com/base/contracts/blob/v8.4.0/src/L2/GasPriceOracle.sol
  const amounts = await Promise.all([
    ['getL1FeeUpperBound', BigInt(getBytes(tx.unsignedSerialized).length)], ['getOperatorFee', gasLimit],
  ].map(async ([method, value]) => {
    const raw: unknown = await provider.send('eth_call', [{ to: ORACLE, data: ABI.encodeFunctionData(String(method), [value]) },
      { blockHash: head.hash, requireCanonical: true }])
    check(typeof raw === 'string' && isHexString(raw, 32))
    return BigInt(raw)
  }))
  const [l1FeeEstimate, operatorFeeEstimate] = amounts, executionMaximum = gasLimit * maxFeePerGas
  const maximumNetworkFee = executionMaximum + 2n * (l1FeeEstimate + operatorFeeEstimate)
  check(maximumNetworkFee > 0n && maximumNetworkFee <= BASE_SETUP_MAX_FUNDING &&
    (await provider.getBlock(head.number))?.hash === head.hash && Date.now() - createdAt <= 30_000)
  // The spend allocation is bounded by funding an empty account exactly; fees can still
  // change before inclusion and leave insufficient funds. Never top up automatically.
  return { createdAt, blockNumber: head.number, blockHash: head.hash, unsignedHash: tx.unsignedHash,
    gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    executionMaximum: executionMaximum.toString(), l1FeeEstimate: l1FeeEstimate.toString(), operatorFeeEstimate: operatorFeeEstimate.toString(),
    maximumNetworkFee: maximumNetworkFee.toString(), feeBound: 'estimate-only' }
}

export async function quoteBaseSetupFees(provider: FeeProvider, request: TransactionRequest): Promise<BaseSetupFeeQuote> {
  try { return await quote(provider, request, false) }
  catch { throw new Error('Base setup fee estimate is unavailable or exceeds its funding limit. Review it again.') }
}

export async function quoteBaseRefundFees(provider: FeeProvider,
  request: TransactionRequest): Promise<BaseSetupFeeQuote> {
  try { return await quote(provider, request, true) }
  catch { throw new Error('Base recovery fee estimate is unavailable or exceeds its funding limit. Review it again.') }
}
