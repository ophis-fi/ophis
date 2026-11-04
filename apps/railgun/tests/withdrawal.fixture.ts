import { ABIRailgunSmartWallet } from '@railgun-community/engine'
import { Interface, ZeroAddress, ZeroHash, zeroPadValue } from 'ethers'

export function withdrawalData(count = 1, unshield = 1, recipient = ZeroAddress, tokenAddress = ZeroAddress, nullifier = `0x${'11'.repeat(32)}`): string {
  return new Interface(ABIRailgunSmartWallet).encodeFunctionData('transact', [Array.from({ length: count }, () => ({
    proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
    merkleRoot: ZeroHash,
    nullifiers: [nullifier],
    commitments: [],
    boundParams: { treeNumber: 0, minGasPrice: 0, unshield, chainID: 1, adaptContract: ZeroAddress,
      adaptParams: ZeroHash, commitmentCiphertext: [] },
    unshieldPreimage: { npk: zeroPadValue(recipient, 32), token: { tokenAddress, tokenType: 0, tokenSubID: 0 }, value: 1000 },
  }))])
}
