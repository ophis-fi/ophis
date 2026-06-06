import { describe, it, expect } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import {
  encodeWethTransfers,
  encodeMultiSend,
  encodeMultiSendCalldata,
  decodeMultiSendCalldata,
  type Transfer,
  type InnerCall,
} from '../src/batch/multisend.js';
import { WETH_GNOSIS } from '../src/safe/addresses.js';

describe('encodeMultiSend', () => {
  it('encodes a single transfer as the concatenated 85+data-length packed format', () => {
    const transfers: Transfer[] = [
      { to: '0xaaaa000000000000000000000000000000000001', amount: 12_345n },
    ];
    const wethCalldata = encodeWethTransfers(transfers, WETH_GNOSIS);
    const packed = encodeMultiSend(wethCalldata);
    // Layout per Safe MultiSend ABI: bytes packed { uint8 op, address to, uint256 value, uint256 dataLen, bytes data }
    //   op=0 (CALL) for CallOnly                       → 1 byte
    //   to = WETH_GNOSIS                               → 20 bytes
    //   value = 0                                      → 32 bytes
    //   dataLen = 68 (4-byte selector + 64 bytes args) → 32 bytes
    //   data = transfer(0xaaaa…, 12345)                → 68 bytes
    // Total = 153 bytes = 306 hex chars (+ 0x prefix)
    expect(packed).toMatch(/^0x[a-f0-9]+$/);
    expect((packed.length - 2) / 2).toBe(153);
  });

  it('encodes N transfers as N concatenated frames', () => {
    const transfers: Transfer[] = [
      { to: '0xaaaa000000000000000000000000000000000001', amount: 1n },
      { to: '0xbbbb000000000000000000000000000000000002', amount: 2n },
      { to: '0xcccc000000000000000000000000000000000003', amount: 3n },
    ];
    const wethCalldata = encodeWethTransfers(transfers, WETH_GNOSIS);
    const packed = encodeMultiSend(wethCalldata);
    expect((packed.length - 2) / 2).toBe(153 * 3);
  });

  it('first 8 bytes of each inner data are the ERC20 transfer selector', () => {
    const transfers: Transfer[] = [{ to: '0xaaaa000000000000000000000000000000000001', amount: 7n }];
    const wethCalldata = encodeWethTransfers(transfers, WETH_GNOSIS);
    // ERC20.transfer(address,uint256) selector = 0xa9059cbb
    expect(wethCalldata[0]!.data.slice(0, 10)).toBe('0xa9059cbb');
  });

  it('inner transfer data matches viem encodeFunctionData (anti-drift check)', () => {
    const erc20Abi = parseAbi(['function transfer(address to, uint256 amount)']);
    const transfers: Transfer[] = [{ to: '0x1234123412341234123412341234123412341234', amount: 999n }];
    const ours = encodeWethTransfers(transfers, WETH_GNOSIS)[0]!.data;
    const viemRef = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [transfers[0]!.to, transfers[0]!.amount],
    });
    expect(ours.toLowerCase()).toBe(viemRef.toLowerCase());
  });
});

describe('decodeMultiSendCalldata (#360 pending-tx inspection)', () => {
  const approveAbi = parseAbi(['function approve(address spender, uint256 amount)']);
  const VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';
  const mkApprove = (to: `0x${string}`, amount: bigint): InnerCall => ({
    to,
    value: 0n,
    data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [VAULT_RELAYER, amount] }),
  });

  it('round-trips inner calls through encode → decode (to / value / data preserved)', () => {
    const calls: InnerCall[] = [
      mkApprove('0xaaaa000000000000000000000000000000000001', 100n),
      mkApprove('0xbbbb000000000000000000000000000000000002', 200n),
    ];
    const outer = encodeMultiSendCalldata(encodeMultiSend(calls));
    const decoded = decodeMultiSendCalldata(outer);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.to.toLowerCase()).toBe(calls[0]!.to.toLowerCase());
    expect(decoded[0]!.data.toLowerCase()).toBe(calls[0]!.data.toLowerCase());
    expect(decoded[0]!.value).toBe(0n);
    expect(decoded[1]!.to.toLowerCase()).toBe(calls[1]!.to.toLowerCase());
    expect(decoded[1]!.data.toLowerCase()).toBe(calls[1]!.data.toLowerCase());
  });

  it('decodes a non-zero value and a zero-length-data inner call', () => {
    const calls: InnerCall[] = [{ to: '0xcccc000000000000000000000000000000000003', value: 123n, data: '0x' }];
    const decoded = decodeMultiSendCalldata(encodeMultiSendCalldata(encodeMultiSend(calls)));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.to.toLowerCase()).toBe('0xcccc000000000000000000000000000000000003');
    expect(decoded[0]!.value).toBe(123n);
    expect(decoded[0]!.data).toBe('0x');
  });

  it('returns [] for calldata that is not a multiSend (a plain approve)', () => {
    const approve = encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [VAULT_RELAYER, 1n] });
    expect(decodeMultiSendCalldata(approve)).toEqual([]);
  });

  it('returns [] for malformed / empty calldata (never throws on a pending owner tx)', () => {
    expect(decodeMultiSendCalldata('0xdeadbeef')).toEqual([]);
    expect(decodeMultiSendCalldata('0x')).toEqual([]);
  });

  it('does NOT throw on a frame declaring an out-of-range data length (untrusted queue input)', () => {
    // A well-formed `multiSend(bytes)` whose single inner frame declares a 2^256-1
    // dataLen. A naive Number() conversion throws IntegerOutOfRangeError; the decoder
    // must treat it as a malformed (overrunning) frame and stop, never throw.
    const hugeLen = 'f'.repeat(64); // 32 bytes, all-F
    const packed = `0x00${'11'.repeat(20)}${'00'.repeat(32)}${hugeLen}` as `0x${string}`;
    const outer = encodeFunctionData({
      abi: parseAbi(['function multiSend(bytes transactions)']),
      functionName: 'multiSend',
      args: [packed],
    });
    expect(() => decodeMultiSendCalldata(outer)).not.toThrow();
    expect(decodeMultiSendCalldata(outer)).toEqual([]); // declared length overruns → nothing parsed
  });
});
