import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodePacked,
  pad,
  slice,
  toHex,
  zeroAddress,
  zeroHash,
  type Hex,
  type TransactionReceipt,
} from 'viem'

import { CCTP_ABI, MESSAGE_TRANSMITTER } from './cctp.const'
import {
  assertCctpQuote,
  cctpBurnData,
  cctpClient,
  circleGet,
  parseCctpAmount,
  type CctpTransfer,
} from './cctp.service'
import { CCTPX_ABI, CROSS_CHAIN_TOKEN_SERVICE, cctpAsset, cctpToken } from './cctpAssets.const'
import { verifyBurnReceipt, verifyMintReceipt, validateCctpMessage } from './cctpMessage.service'
import { cctpTransferSchema } from './cctpState'
import { getCctpStatus } from './cctpStatus.service'
import { assertCctpxQuote, parseCctpxQuote } from './cctpx.service'

jest.mock('./cctp.service', () => ({
  ...jest.requireActual('./cctp.service'),
  cctpClient: jest.fn(),
  circleGet: jest.fn(),
}))

const owner = '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A'
const signedQuote = `0x${'11'.repeat(100)}` as Hex
const now = Date.now()
const transfer: CctpTransfer = {
  asset: 'EURC',
  source: 8453,
  destination: 5042,
  owner,
  amount: '10000000',
  maxFee: '0',
  quotedAt: now,
  expanded: {
    signedQuote,
    feeTotalAmount: '20000000000000',
    issuedAt: Math.floor(now / 1000),
    expiry: { mode: 'BLOCK_NUMBER', expiresAtBlock: 5000, blockEstimatedAt: Math.floor(now / 1000) + 120 },
  },
}
const response = {
  ...transfer.expanded,
  feeToken: zeroAddress,
  items: [
    { type: 'FORWARD', amount: '20000000000000', args: ['26', 'TransferMessage', zeroHash, 'false', '', owner] },
    { type: 'PROTOCOL', amount: '0', args: [cctpAsset('EURC').tokenId] },
  ],
}
const u32 = (value: number): Hex => toHex(value, { size: 4 })
const word = (value: number): Hex => toHex(value, { size: 32 })
// CCTS owns the body encoding. Bind opaque bytes to the finalized receipt of
// our exact calldata, rather than guessing a codec for an upgradeable service.
const body = encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
  [zeroHash, owner, 10000000n],
)
const message = concat([
  u32(1),
  u32(6),
  u32(26),
  word(42),
  pad(CROSS_CHAIN_TOKEN_SERVICE),
  pad(CROSS_CHAIN_TOKEN_SERVICE),
  zeroHash,
  u32(2000),
  u32(2000),
  body,
])
function receipt(logs: TransactionReceipt['logs']): TransactionReceipt {
  return { status: 'success', from: owner, to: CROSS_CHAIN_TOKEN_SERVICE, logs } as TransactionReceipt
}

it('keeps old USDC journals and rejects unsupported or incomplete expanded-asset journals', () => {
  const usdc = { ...transfer, asset: undefined, expanded: undefined, maxFee: '20000' }
  expect(cctpTransferSchema.safeParse(usdc).success).toBe(true)
  const persisted = cctpTransferSchema.parse(JSON.parse(JSON.stringify(transfer)))
  expect(persisted).toEqual(transfer)
  for (const invalid of [
    { ...transfer, asset: 'USYC' },
    { ...transfer, source: 10 },
    { ...transfer, expanded: undefined },
    { ...transfer, maxFee: '1' },
    { ...transfer, asset: 'USDC' },
    { ...transfer, expanded: { ...transfer.expanded, feeTotalAmount: '-1' } },
    { ...transfer, expanded: { ...transfer.expanded, feeTotalAmount: 'not a number' } },
    { ...transfer, expanded: { ...transfer.expanded, feeTotalAmount: '9'.repeat(78) } },
  ])
    expect(cctpTransferSchema.safeParse(invalid).success).toBe(false)
  expect(() => assertCctpQuote(transfer, now)).not.toThrow()
  expect(() => assertCctpQuote(transfer, now + 61000)).toThrow('expired')
  const fee = parseCctpxQuote(response, transfer)
  expect(() => assertCctpxQuote(fee, { number: 5000n, timestamp: 1n })).toThrow('expired')
  expect(() => assertCctpxQuote(fee, { number: 4999n, timestamp: 9999999999n })).not.toThrow()
})

it('encodes native EURC and eight-decimal cirBTC with exact receiver, fees, no hook and standard finality', () => {
  expect(parseCctpAmount('0.00000001', 'cirBTC')).toBe(1n)
  expect(parseCctpAmount('1.23456789', 'cirBTC')).toBe(123456789n)
  expect(() => parseCctpAmount('0.000000001', 'cirBTC')).toThrow()
  expect(() => parseCctpAmount('0.0000001', 'EURC')).toThrow()
  for (const asset of ['EURC', 'cirBTC'] as const) {
    const quote = { ...transfer, asset, source: 1 }
    const decoded = decodeFunctionData({ abi: CCTPX_ABI, data: cctpBurnData(quote) })
    expect(decoded.functionName).toBe('crossChainTransfer')
    expect(decoded.args).toEqual([
      cctpAsset(asset).tokenId,
      10000000n,
      26,
      encodePacked(['address'], [owner]),
      zeroHash,
      2000,
      { signedQuote, refundAddress: owner },
      false,
      '0x',
    ])
  }
  expect(() => cctpToken(8453, 'cirBTC')).toThrow()
})

it('accepts only matching native-fee forwarding quotes with an explicit total and supported expiry', () => {
  expect(parseCctpxQuote(response, transfer)).toEqual(transfer.expanded)
  for (const invalid of [
    { ...response, feeToken: owner },
    { ...response, feeTotalAmount: '20000000000001' },
    { ...response, items: response.items.slice(0, 1) },
    { ...response, items: [...response.items, response.items[0]] },
    { ...response, expiry: { mode: 'TIMESTAMP', expiresAt: 'tomorrow' } },
    { ...response, signedQuote: '0x' },
  ])
    expect(() => parseCctpxQuote(invalid, transfer)).toThrow()
  for (const [index, replacement] of [
    [0, '0'],
    [1, 'OtherMessage'],
    [2, pad(owner)],
    [3, 'true'],
    [4, '0xab'],
    [5, zeroAddress],
  ] as const) {
    const altered = JSON.parse(JSON.stringify(response))
    altered.items[0].args[index] = replacement
    expect(() => parseCctpxQuote(altered, transfer)).toThrow()
  }
})

it('binds non-USDC attestations to source evidence and requires an exact destination token receipt', () => {
  const sent = {
    address: MESSAGE_TRANSMITTER,
    topics: encodeEventTopics({ abi: CCTP_ABI, eventName: 'MessageSent' }),
    data: encodeAbiParameters([{ type: 'bytes' }], [message]),
  }
  expect(verifyBurnReceipt(receipt([sent] as TransactionReceipt['logs']), transfer)).toBe(message.toLowerCase())
  expect(() => validateCctpMessage(message, transfer)).toThrow('verified source')
  expect(() => validateCctpMessage(concat([message, '0x01']), transfer, message)).toThrow('verified source')
  expect(() => validateCctpMessage(message, { ...transfer, destination: 1 }, message)).toThrow('route')
  const received = {
    address: MESSAGE_TRANSMITTER,
    topics: encodeEventTopics({
      abi: CCTP_ABI,
      eventName: 'MessageReceived',
      args: { caller: owner, nonce: word(42), finalityThresholdExecuted: 2000 },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
      [6, pad(CROSS_CHAIN_TOKEN_SERVICE), body],
    ),
  }
  const mint = {
    address: cctpToken(5042, 'EURC'),
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(zeroAddress), pad(owner)],
    data: word(10000000),
  }
  expect(() =>
    verifyMintReceipt(receipt([received, mint] as TransactionReceipt['logs']), message, transfer, message),
  ).not.toThrow()
  for (const bad of [
    { ...mint, address: cctpToken(5042, 'USDC') },
    { ...mint, data: word(9999999) },
  ])
    expect(() =>
      verifyMintReceipt(receipt([received, bad] as TransactionReceipt['logs']), message, transfer, message),
    ).toThrow('does not confirm')
  expect(() => verifyMintReceipt(receipt([mint] as TransactionReceipt['logs']), message, transfer, message)).toThrow()
})

it('requires finalized exact source evidence despite a boolean cache and reuses only the verified body', async () => {
  const hash: Hex = `0x${'ab'.repeat(32)}`
  const saved = { ...transfer, burnHash: hash, sourceNonce: 7 }
  const sourceMessage = concat([slice(message, 0, 12), zeroHash, slice(message, 44)])
  const sent = {
    address: MESSAGE_TRANSMITTER,
    topics: encodeEventTopics({ abi: CCTP_ABI, eventName: 'MessageSent' }),
    data: encodeAbiParameters([{ type: 'bytes' }], [sourceMessage]),
  }
  const client = {
    getTransactionReceipt: jest
      .fn()
      .mockResolvedValue({ ...receipt([sent] as TransactionReceipt['logs']), blockNumber: 10n, blockHash: hash }),
    getTransaction: jest.fn().mockResolvedValue({
      from: owner,
      to: CROSS_CHAIN_TOKEN_SERVICE,
      input: cctpBurnData(saved),
      value: 20000000000000n,
      nonce: 7,
    }),
    getBlock: jest.fn().mockResolvedValue({ number: 11n, hash }),
  }
  jest.mocked(cctpClient).mockReturnValue(client as unknown as ReturnType<typeof cctpClient>)
  jest
    .mocked(circleGet)
    .mockResolvedValue({ sourceTxHash: hash, messages: [{ message, attestation: `0x${'aa'.repeat(65)}` }] })
  client.getTransaction.mockResolvedValueOnce({
    from: owner,
    to: CROSS_CHAIN_TOKEN_SERVICE,
    input: cctpBurnData(saved),
    value: 0n,
    nonce: 7,
  })
  await expect(getCctpStatus(saved, true)).rejects.toThrow('does not match')
  expect(circleGet).not.toHaveBeenCalled()
  client.getBlock.mockResolvedValueOnce({ number: 9n, hash })
  expect((await getCctpStatus(saved, true)).sourceConfirmed).toBe(false)
  expect(circleGet).not.toHaveBeenCalled()
  const ready = await getCctpStatus(saved, true)
  expect(ready.sourceMessage).toBe(sourceMessage.toLowerCase())
  expect(ready.message).toBe(message)
  const reads = client.getTransaction.mock.calls.length
  expect((await getCctpStatus(saved, ready.sourceMessage)).sourceConfirmed).toBe(true)
  expect(client.getTransaction).toHaveBeenCalledTimes(reads)
  jest.mocked(circleGet).mockResolvedValueOnce({
    sourceTxHash: hash,
    messages: [{ message: concat([message, '0x01']), attestation: `0x${'aa'.repeat(65)}` }],
  })
  await expect(getCctpStatus(saved, ready.sourceMessage)).rejects.toThrow('verified source')
  jest.mocked(circleGet).mockResolvedValueOnce({ messages: [{ message, attestation: `0x${'aa'.repeat(65)}` }] })
  await expect(getCctpStatus(saved, ready.sourceMessage)).rejects.toThrow('omitted its hash')
})

it('preserves 18-decimal transfers and validates every reviewed registry route across refresh', () => {
  const { CCTP_ASSETS, cctpAssetRoute, cctpSpender } =
    jest.requireActual<typeof import('./cctpAssets.const')>('./cctpAssets.const')
  expect(new Set(CCTP_ASSETS).size).toBe(CCTP_ASSETS.length)
  expect(CCTP_ASSETS.length).toBe(40)
  for (const asset of CCTP_ASSETS.filter((item) => item !== 'USDC')) {
    const route = cctpAssetRoute(asset, 5042, 1)
    const quote = { ...transfer, asset, ...route, amount: parseCctpAmount('1.25', asset).toString() }
    expect(cctpTransferSchema.parse(JSON.parse(JSON.stringify(quote)))).toEqual(quote)
    const decoded = decodeFunctionData({ abi: CCTPX_ABI, data: cctpBurnData(quote) })
    expect(decoded.args?.[0]).toBe(cctpAsset(asset).tokenId)
    expect(decoded.args?.[1]).toBe(BigInt(quote.amount))
    expect(cctpSpender(asset)).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(cctpToken(quote.source, asset)).not.toBe(cctpToken(quote.destination, asset))
  }
  expect(parseCctpAmount('1.250000000000000001', 'WETH')).toBe(1250000000000000001n)
  expect(() => parseCctpAmount('0.0000000000000000001', 'WETH')).toThrow()
  const weth = { ...transfer, asset: 'WETH', source: 5042, destination: 1, amount: '1250000000000000001' }
  for (const amount of ['0', '-1', '01', '0x10', '1e18', '9'.repeat(78)]) {
    expect(cctpTransferSchema.safeParse({ ...weth, amount }).success).toBe(false)
  }
  expect(cctpTransferSchema.safeParse({ ...transfer, amount: '10000000000001' }).success).toBe(false)
  expect(cctpTransferSchema.safeParse({ ...weth, source: 10 }).success).toBe(false)
})
