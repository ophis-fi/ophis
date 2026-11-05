import { closeSync, constants, existsSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContractFactory, getAddress, getCreateAddress, Interface, keccak256, Transaction, type JsonRpcProvider } from 'ethers'
import { GUARD_ARTIFACT } from '../../railgun/operator/execution-guard-artifact'
import { executionGuardCode } from '../../railgun/operator/execution-guard'
import { protectedWriteRPC } from '../../railgun/operator/protected-provider'
import { assertSigningNetwork, CHAIN, CHAIN_ID, NETWORK, type Settings } from './config'
import { signApprovedTransaction, type GasSigner } from './signer'
import { privateDirectory } from './storage'
import { readChainState } from './chain-state'

export interface GuardApproval {
  chainId: number; gasOperator: string; predictedGuard: string; canonicalDelegate: string
  expectedRuntimeKeccak256: string; approvedDeploymentCostCeilingWei: string
  gasFundingApproved: boolean; proposal: { maxGasPriceWei: string; reserveWei: string; maxTransactionCostWei: string }
}

const registry = new Interface(['function getContractAddress(string) view returns (address)'])

export async function deployGuard(config: Settings, approval: GuardApproval, provider: JsonRpcProvider, signer: GasSigner) {
  assertSigningNetwork(config)
  const writeRPC = protectedWriteRPC(CHAIN_ID)
  const operator = getAddress(signer.address), guard = getCreateAddress({ from: operator, nonce: 0 })
  if (config.chainId !== CHAIN_ID || config.mode !== 'mainnet' || config.enabled || approval.chainId !== CHAIN_ID || approval.gasFundingApproved !== true ||
    operator !== config.operatorAddress || getAddress(approval.gasOperator) !== operator ||
    getAddress(approval.predictedGuard) !== guard || getAddress(approval.canonicalDelegate) !== getAddress(NETWORK.relayAdapt7702Contract))
    throw new Error('An unarmed, explicitly approved operator-bound deployment is required.')
  privateDirectory(config.state)
  const path = join(config.state, 'guard-deployment-signed.json')
  if (existsSync(path)) throw new Error('A deployment is already journaled. Reconcile it before any new signature.')
  const price = BigInt(approval.proposal.maxGasPriceWei), ceiling = BigInt(approval.approvedDeploymentCostCeilingWei)
  const reserve = BigInt(approval.proposal.reserveWei), pilot = BigInt(approval.proposal.maxTransactionCostWei)
  if (price <= 0n || ceiling <= 0n || pilot <= 0n || reserve < pilot ||
    (CHAIN_ID === 1 ? price > 500_000_000n || ceiling > 250_000_000_000_000n || reserve < 1_500_000_000_000_000n
      : !config.maxGasPrice || !config.maxTransactionCost || !config.reserve || price > config.maxGasPrice ||
        ceiling > config.maxTransactionCost || pilot > config.maxTransactionCost || reserve < config.reserve))
    throw new Error('Deployment exceeds the approved financial limits.')
  const { block, baseFee, minimumGasPrice } = await readChainState(provider)
  const tip = minimumGasPrice > baseFee ? minimumGasPrice - baseFee : 1n
  if (baseFee * 2n + 1n > price || minimumGasPrice > price || (await provider.getNetwork()).chainId !== CHAIN)
    throw new Error('Wait for a fresh head whose fee fits the approved deployment cap.')
  const tag = `0x${block.number.toString(16)}`
  const [delegateCode, operatorCode, guardCode, nonce, pendingNonce, registered] = await Promise.all([
    provider.getCode(NETWORK.relayAdapt7702Contract, block.number), provider.getCode(operator, block.number),
    provider.getCode(guard, block.number), provider.getTransactionCount(operator, block.number),
    provider.getTransactionCount(operator, 'pending'), provider.call({ to: NETWORK.railgunRegistryContract,
      data: registry.encodeFunctionData('getContractAddress', ['RelayAdapt7702']), blockTag: block.number }),
  ])
  if (operatorCode !== '0x' || guardCode !== '0x' || nonce !== 0 || pendingNonce !== 0 ||
    getAddress(registry.decodeFunctionResult('getContractAddress', registered)[0]) !== getAddress(NETWORK.relayAdapt7702Contract))
    throw new Error('Operator nonce/code or canonical registry changed.')
  const expected = executionGuardCode(operator, delegateCode, NETWORK.relayAdapt7702Contract)
  if (keccak256(expected) !== approval.expectedRuntimeKeccak256) throw new Error('The reviewed delegate/guard runtime changed.')
  const creation = await new ContractFactory(GUARD_ARTIFACT.abi, GUARD_ARTIFACT.bytecode)
    .getDeployTransaction(operator, NETWORK.relayAdapt7702Contract)
  const transaction = { ...creation, from: operator, value: 0n, type: 2, chainId: CHAIN, nonce: 0,
    maxFeePerGas: price, maxPriorityFeePerGas: tip }
  const estimate = await provider.estimateGas(transaction), gasLimit = (estimate * 120n + 99n) / 100n
  if (gasLimit * price > ceiling || await provider.getBalance(operator) < reserve + pilot + gasLimit * price)
    throw new Error('Deployment would exceed its ceiling or consume the reserved pilot balance.')
  const simulated = await provider.send('eth_call', [{ from: operator, value: '0x0', data: creation.data,
    type: '0x2', nonce: '0x0', maxFeePerGas: `0x${price.toString(16)}`, maxPriorityFeePerGas: `0x${tip.toString(16)}`, gas: `0x${gasLimit.toString(16)}` }, tag])
  if (simulated.toLowerCase() !== expected.toLowerCase() || await provider.getTransactionCount(operator, 'pending') !== 0)
    throw new Error('The exact funded constructor simulation or nonce check failed.')
  const raw = await signApprovedTransaction(signer, { ...transaction, gasLimit })
  const hash = Transaction.from(raw).hash!
  const record = { chainId: CHAIN_ID, hash, raw, operator, guard, expectedRuntimeKeccak256: approval.expectedRuntimeKeccak256,
    maximumCostWei: (gasLimit * price).toString(), createdAt: Date.now(), confirmed: false }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(config.state, constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
  try {
    const response = await fetch(writeRPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
    const result = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown }
    if (!response.ok || result.jsonrpc !== '2.0' || result.id !== 1 || result.error || result.result !== hash) throw new Error()
  } catch { throw new Error('Deployment outcome is unknown. Its signed bytes are journaled; no public fallback or new signature was attempted.') }
  return { status: 'protected-deployment-submitted', hash, guard, maximumCostWei: record.maximumCostWei }
}
