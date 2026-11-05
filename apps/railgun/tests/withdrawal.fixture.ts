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

export function mixedWithdrawalTransactions(tokenAddress: string, recipient: string) {
  const base = {
    proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } }, merkleRoot: ZeroHash,
    nullifiers: [`0x${'11'.repeat(32)}`],
    boundParams: { treeNumber: 0, minGasPrice: 0, unshield: 1, chainID: 56, adaptContract: ZeroAddress, adaptParams: ZeroHash },
  }
  const ciphertext = { ciphertext: [ZeroHash, ZeroHash, ZeroHash, ZeroHash], blindedSenderViewingKey: ZeroHash,
    blindedReceiverViewingKey: ZeroHash, annotationData: '0x', memo: '0x' }
  const fee = { ...base, commitments: [`0x${'31'.repeat(32)}`],
    boundParams: { ...base.boundParams, chainID: 56, unshield: 0, commitmentCiphertext: [ciphertext] },
    unshieldPreimage: { npk: ZeroHash, token: { tokenAddress: ZeroAddress, tokenType: 0, tokenSubID: 0 }, value: 0n } }
  const principal = { ...base, nullifiers: [`0x${'22'.repeat(32)}`], commitments: [`0x${'32'.repeat(32)}`, `0x${'33'.repeat(32)}`],
    boundParams: { ...base.boundParams, chainID: 56, commitmentCiphertext: [ciphertext] },
    unshieldPreimage: { npk: zeroPadValue(recipient, 32), token: { tokenAddress, tokenType: 0, tokenSubID: 0 }, value: 1000n } }
  return [fee, principal]
}

export function mixedWithdrawalData(tokenAddress: string, recipient: string): string {
  return new Interface(ABIRailgunSmartWallet).encodeFunctionData('transact', [mixedWithdrawalTransactions(tokenAddress, recipient)])
}
