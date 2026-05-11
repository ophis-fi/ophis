import { describe, it, expect } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import { encodeWethTransfers, encodeMultiSend, type Transfer } from '../src/batch/multisend.js';
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
