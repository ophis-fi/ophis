import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  pad,
  toHex,
  zeroAddress,
  zeroHash,
  type Hex,
  type TransactionReceipt,
  TransactionReceiptNotFoundError,
} from 'viem'

import { CCTP_ABI, FORWARD_HOOK, MESSAGE_TRANSMITTER, TOKEN_MESSENGER } from './cctp.const'
import {
  cctpClient,
  circleGet,
  assertCctpQuote,
  calculateCctpFee,
  cctpBurnData,
  parseCctpAmount,
  type CctpTransfer,
} from './cctp.service'
import { cctpTransferSchema } from './cctpState'
import { getCctpStatus, validateCctpMessage, verifyBurnReceipt, verifyMintReceipt } from './cctpStatus.service'
import { resumeCctpClaim } from './cctpSubmission.service'

jest.mock('./cctp.service', () => ({
  ...jest.requireActual('./cctp.service'),
  cctpClient: jest.fn(),
  circleGet: jest.fn(),
}))

const owner = '0x0494F503912C101Bfd76b88e4F5D8A33de284d1A'
const transfer: CctpTransfer = {
  source: 8453,
  destination: 5042,
  owner,
  amount: '2000000',
  maxFee: '15638',
  quotedAt: 1000,
}
const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const word = (value: number): Hex => toHex(value, { size: 32 })
const u32 = (value: number): Hex => toHex(value, { size: 4 })
const header = concat([
  u32(1),
  u32(6),
  u32(26),
  word(42),
  pad(TOKEN_MESSENGER),
  pad(TOKEN_MESSENGER),
  zeroHash,
  u32(2000),
  u32(2000),
])
const body = concat([
  u32(1),
  pad(usdc),
  pad(owner),
  word(2000000),
  pad(owner),
  word(15638),
  word(15638),
  word(99999999),
  FORWARD_HOOK,
])
const message = concat([header, body])

function replace(message: Hex, byte: number, replacement: Hex): Hex {
  return `${message.slice(0, 2 + byte * 2)}${replacement.slice(2)}${message.slice(byte * 2 + replacement.length)}` as Hex
}

it('uses six-decimal USDC and rejects rounding, scientific notation, negatives and oversized amounts', () => {
  expect(parseCctpAmount('2')).toBe(2000000n)
  expect(parseCctpAmount('0.000001')).toBe(1n)
  for (const value of ['0', '-1', '1e6', 'NaN', '1.0000001', '10000000.000001'])
    expect(() => parseCctpAmount(value)).toThrow()
})

it('rounds protocol fees upward and requires explicit standard forwarding support', () => {
  expect(calculateCctpFee([{ finalityThreshold: 2000, minimumFee: 0.325, forwardFee: { med: 15638 } }], 2000001n)).toBe(
    15704n,
  )
  expect(() => calculateCctpFee([{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { med: 5 } }], 100n)).toThrow()
  expect(() => calculateCctpFee([{ finalityThreshold: 2000, minimumFee: 0 }], 100n)).toThrow()
  expect(() => calculateCctpFee([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 100 } }], 100n)).toThrow()
})

it('binds the burn to Arc domain 26, exact approval amount, same-wallet recipient and forwarding hook', () => {
  const decoded = decodeFunctionData({ abi: CCTP_ABI, data: cctpBurnData(transfer) })
  expect(decoded.functionName).toBe('depositForBurnWithHook')
  expect(decoded.args).toEqual([2000000n, 26, pad(owner).toLowerCase(), usdc, zeroHash, 15638n, 2000, FORWARD_HOOK])
  expect(() => assertCctpQuote(transfer, 61001)).toThrow('expired')
  expect(() => assertCctpQuote(transfer, 999)).toThrow('expired')
  expect(cctpTransferSchema.safeParse({ ...transfer, source: 4663 }).success).toBe(false)
  expect(cctpTransferSchema.safeParse({ ...transfer, amount: 'NaN' }).success).toBe(false)
})

it('rejects substituted domains, contracts, recipients, amounts, fees, caller and hook in an attestation', () => {
  expect(() => validateCctpMessage(message, transfer)).not.toThrow()
  for (const [offset, value] of [
    [4, u32(0)],
    [8, u32(10)],
    [44, pad(owner)],
    [76, pad(owner)],
    [108, word(1)],
    [140, u32(1000)],
    [152, pad(owner)],
    [184, pad(zeroAddress)],
    [216, word(1)],
    [248, pad(zeroAddress)],
    [280, word(15639)],
    [312, word(15639)],
    [376, zeroHash],
  ] as const) {
    expect(() => validateCctpMessage(replace(message, offset, value), transfer)).toThrow()
  }
  expect(() => validateCctpMessage('0x01', transfer)).toThrow()
})

function receipt(logs: TransactionReceipt['logs'], to = TOKEN_MESSENGER): TransactionReceipt {
  return { status: 'success', from: owner, to, logs } as TransactionReceipt
}

it('requires the source MessageSent from Circle and destination message plus received USDC', () => {
  const sent = {
    address: MESSAGE_TRANSMITTER,
    topics: encodeEventTopics({ abi: CCTP_ABI, eventName: 'MessageSent' }),
    data: encodeAbiParameters([{ type: 'bytes' }], [message]),
  }
  expect(() => verifyBurnReceipt(receipt([sent] as TransactionReceipt['logs']), transfer)).not.toThrow()
  expect(() => verifyBurnReceipt(receipt([]), transfer)).toThrow()
  const received = {
    address: MESSAGE_TRANSMITTER,
    topics: encodeEventTopics({
      abi: CCTP_ABI,
      eventName: 'MessageReceived',
      args: { caller: owner, nonce: word(42), finalityThresholdExecuted: 2000 },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
      [6, pad(TOKEN_MESSENGER), body],
    ),
  }
  const mint = {
    address: '0x3600000000000000000000000000000000000000',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(zeroAddress), pad(owner)],
    data: word(1984362),
  }
  expect(() =>
    verifyMintReceipt(receipt([received, mint] as TransactionReceipt['logs']), message, transfer),
  ).not.toThrow()
  // Arc emits both streams. Only the six-decimal ERC-20 log proves the
  // received CCTP amount here; the system emitter carries 18-decimal units.
  const nativeMint = {
    ...mint,
    address: '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE',
    data: toHex(1984362n * 10n ** 12n, { size: 32 }),
  }
  expect(() =>
    verifyMintReceipt(receipt([nativeMint, received, mint] as TransactionReceipt['logs']), message, transfer),
  ).not.toThrow()
  expect(() =>
    verifyMintReceipt(receipt([nativeMint, received] as TransactionReceipt['logs']), message, transfer),
  ).toThrow()
  expect(() => verifyMintReceipt(receipt([received] as TransactionReceipt['logs']), message, transfer)).toThrow()
  expect(() => verifyMintReceipt(receipt([mint] as TransactionReceipt['logs']), message, transfer)).toThrow()
  expect(() =>
    verifyMintReceipt(
      receipt([{ ...received, address: owner }, mint] as TransactionReceipt['logs']),
      message,
      transfer,
    ),
  ).toThrow()
})

it('keeps a pending manual claim locked when forwarding reverted and recovers a mined claim from its receipt', async () => {
  const mintHash = `0x${'ab'.repeat(32)}` as Hex
  const forwardTxHash = `0x${'cd'.repeat(32)}` as Hex
  const burnHash = `0x${'ef'.repeat(32)}` as Hex
  const sent = {
    address: MESSAGE_TRANSMITTER,
    topics: encodeEventTopics({ abi: CCTP_ABI, eventName: 'MessageSent' }),
    data: encodeAbiParameters([{ type: 'bytes' }], [message]),
  }
  const client = {
    getBlock: jest.fn().mockResolvedValue({ number: 600n }),
    getTransactionReceipt: jest.fn().mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (hash === mintHash) throw new TransactionReceiptNotFoundError({ hash })
      if (hash === burnHash) return receipt([sent] as TransactionReceipt['logs'])
      return { status: 'reverted' }
    }),
    getTransaction: jest
      .fn()
      .mockResolvedValue({ from: owner, to: TOKEN_MESSENGER, input: cctpBurnData(transfer), value: 0n, nonce: 7 }),
  }
  jest.mocked(cctpClient).mockReturnValue(client as unknown as ReturnType<typeof cctpClient>)
  jest
    .mocked(circleGet)
    .mockResolvedValue({ messages: [{ message, attestation: `0x${'01'.repeat(65)}`, forwardTxHash }] })
  const stored = { ...transfer, sourceNonce: 7, burnHash, mintHash, claimNonce: 9 }
  expect(await getCctpStatus(stored, true)).toEqual(
    expect.objectContaining({ completed: false, claimPending: true, mintHash }),
  )
  const unknown = { ...stored, mintHash: undefined }
  expect(await getCctpStatus(unknown, true)).toEqual(expect.objectContaining({ completed: false, claimPending: true }))
  client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
    hash === burnHash ? receipt([sent] as TransactionReceipt['logs']) : receipt([]),
  )
  await expect(resumeCctpClaim(unknown, mintHash)).rejects.toThrow('does not confirm')
  const received = {
    address: MESSAGE_TRANSMITTER,
    topics: encodeEventTopics({
      abi: CCTP_ABI,
      eventName: 'MessageReceived',
      args: { caller: owner, nonce: word(42), finalityThresholdExecuted: 2000 },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
      [6, pad(TOKEN_MESSENGER), body],
    ),
  }
  const mint = {
    address: '0x3600000000000000000000000000000000000000',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(zeroAddress), pad(owner)],
    data: word(1984362),
  }
  client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
    if (hash === burnHash) return receipt([sent] as TransactionReceipt['logs'])
    if (hash === mintHash) return receipt([received, mint] as TransactionReceipt['logs'])
    return { status: 'reverted' }
  })
  const recovered = await resumeCctpClaim(unknown, mintHash)
  expect(recovered.mintHash).toBe(mintHash)
  expect((await getCctpStatus(recovered)).completed).toBe(true)
  // A cancelled destination claim can release only its own finalized nonce.
  client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
    if (hash === burnHash) return receipt([sent] as TransactionReceipt['logs'])
    if (hash === mintHash) return { ...receipt([]), blockNumber: 500n }
    return { status: 'reverted' }
  })
  client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) =>
    hash === burnHash
      ? { from: owner, to: TOKEN_MESSENGER, input: cctpBurnData(transfer), value: 0n, nonce: 7 }
      : { from: owner, to: owner, input: '0x', value: 0n, nonce: 9 },
  )
  client.getBlock.mockResolvedValueOnce({ number: 499n })
  await expect(resumeCctpClaim(unknown, mintHash)).rejects.toThrow('become final')
  const cancelled = await resumeCctpClaim(unknown, mintHash)
  expect(cancelled.claimNonce).toBeUndefined()
  expect(cancelled.mintHash).toBeUndefined()
  expect((await getCctpStatus(cancelled)).claimPending).not.toBe(true)
  await expect(resumeCctpClaim({ ...unknown, claimNonce: 8 }, mintHash)).rejects.toThrow('does not confirm')
})
