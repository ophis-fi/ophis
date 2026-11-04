import assert from 'node:assert/strict'
import { isError, JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { decodeGuardedExecution, EXECUTION_GUARD } from '../../railgun/operator/execution-guard'
import { ADAPT } from '../src/transaction'

/** Models a user's authorized delegation clear only on a verified, disposable loopback fork. */
export async function probeGuardRace(provider: JsonRpcProvider, wallet: Wallet, raw: string) {
  assert.equal(new URL(provider._getConnection().url).hostname, '127.0.0.1')
  assert.equal((await provider.send('anvil_metadata', [])).forkedNetwork?.chainId, 1)
  const tx = Transaction.from(raw)
  assert.equal(tx.type, 4); assert.equal(tx.from, wallet.address)
  assert.equal(tx.chainId, 1n); assert.equal(tx.authorizationList?.length, 1)
  const { account, execution } = decodeGuardedExecution(tx.data)
  const decoded = ADAPT.decodeFunctionData('execute', execution)
  assert(decoded._transactions.length > 0 && decoded._transactions[0].commitments.length > 0)
  const snapshot = await provider.send('evm_snapshot', [])
  try {
    await provider.send('anvil_setCode', [account, '0x'])
    await provider.send('anvil_setNonce', [account, `0x${(tx.authorizationList![0].nonce + 1n).toString(16)}`])
    const changed = await provider.send('evm_snapshot', [])
    const balance = await provider.getBalance(wallet.address)
    const fields = { chainId: 1, type: 4, nonce: tx.nonce, value: 0n, gasLimit: tx.gasLimit,
      maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, authorizationList: tx.authorizationList }
    const naked = await wallet.signTransaction({ ...fields, to: account, data: execution })
    const sent = await provider.broadcastTransaction(naked)
    await provider.send('anvil_mine', [2])
    const receipt = await provider.getTransactionReceipt(sent.hash)
    assert(receipt); assert.equal(receipt.status, 1)
    assert.equal(receipt.logs.length, 0, 'The naked no-op must not deliver a private fee.')
    const spent = balance - await provider.getBalance(wallet.address)
    assert(spent > 0n); assert.equal(spent, receipt.gasUsed * receipt.gasPrice)
    assert.equal(await provider.send('evm_revert', [changed]), true)
    const beforeGuard = await provider.getBalance(wallet.address)
    let reason: string | undefined
    try { await provider.call({ ...fields, from: wallet.address, to: tx.to, data: tx.data }) }
    catch (error) {
      if (!isError(error, 'CALL_EXCEPTION') || !error.data) throw error
      reason = EXECUTION_GUARD.parseError(error.data)?.name
    }
    assert.equal(reason, 'UnexpectedDelegate')
    assert.equal(await provider.getBalance(wallet.address), beforeGuard)
    assert.equal(await provider.getTransactionCount(wallet.address), tx.nonce)
    return { validFeeBearingRequest: true, nakedStatus: receipt.status, nakedFeeLogs: receipt.logs.length,
      nakedGasUsed: String(receipt.gasUsed), nakedUnreimbursedWei: String(spent),
      guardedRejection: reason, guardedUnpaidSubmission: false,
      inclusionPolicy: 'Rejected simulation is not published; real Flashbots behavior is not exercised.' }
  } finally {
    assert.equal(await provider.send('evm_revert', [snapshot]), true)
  }
}
