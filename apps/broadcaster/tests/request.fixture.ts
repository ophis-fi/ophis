import { AbiCoder, keccak256, Wallet, zeroPadValue } from 'ethers'
import { signExecutionAuthorization, RelayAdapt7702Helper, RelayAdapt7702ExecutionType, type TransactionStructV2 } from '@railgun-community/engine'
import { ADAPT, PROXY } from '../src/transaction'
import { CHAIN_ID, NETWORK, TOKENS, VERSION, settings } from '../src/config'
import { withdrawalData } from '../../railgun/tests/withdrawal.fixture'

export const config = settings({ OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_MODE: 'fork',
  OPHIS_BROADCASTER_CHAIN_ID: String(CHAIN_ID),
  OPHIS_BROADCASTER_MARGIN_BPS: '1500',
  OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:8559', OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '10000000000',
  OPHIS_BROADCASTER_MAX_TX_COST_WEI: '10000000000000000', OPHIS_BROADCASTER_RESERVE_WEI: '10000000000000000',
  OPHIS_BROADCASTER_DAILY_BUDGET_WEI: '100000000000000000' })

export async function privateRequest(feesID: string, publicViewingKey: string, nullifier = `0x${'12'.repeat(32)}`, minimumGasPrice = 0n) {
  const ephemeral = Wallet.createRandom()
  const type = PROXY.getFunction('transact')!.inputs[0].arrayChildren!
  const tx = Array.from(AbiCoder.defaultAbiCoder().getDefaultValue([type])[0])
  tx[type.components!.findIndex((p) => p.name === 'nullifiers')] = [nullifier]
  tx[type.components!.findIndex((p) => p.name === 'commitments')] = [`0x${'34'.repeat(32)}`]
  const index = type.components!.findIndex((p) => p.name === 'boundParams')
  const bound = Array.from(tx[index] as unknown[])
  bound[type.components![index].components!.findIndex((p) => p.name === 'minGasPrice')] = minimumGasPrice
  if (CHAIN_ID === 56) {
    bound[type.components![index].components!.findIndex((p) => p.name === 'chainID')] = CHAIN_ID
    bound[type.components![index].components!.findIndex((p) => p.name === 'adaptContract')] = ephemeral.address
  }
  tx[index] = bound
  const transactions = [tx as unknown as TransactionStructV2]
  const action = RelayAdapt7702Helper.getActionData(false, [], 0n)
  const signature = await signExecutionAuthorization(ephemeral, transactions, action, CHAIN_ID,
    { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n })
  const auth = await ephemeral.authorize({ chainId: CHAIN_ID, nonce: 0, address: NETWORK.relayAdapt7702Contract })
  return JSON.parse(JSON.stringify({
    txidVersion: VERSION, chainType: 0, chainID: CHAIN_ID, minVersion: '8.0.0', maxVersion: '8.999.0',
    feesID, broadcasterViewingKey: publicViewingKey, transactType: 'TX7702', useRelayAdapt: true,
    to: ephemeral.address, data: ADAPT.encodeFunctionData('execute', [transactions, action, 0n, signature]),
    gasLimit: '1000000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000',
    authorization: auth, preTransactionPOIsPerTxidLeafPerList: {},
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value)) as Record<string, unknown>
}

export async function withdrawalRequest(feesID: string, publicViewingKey: string, recipient: string, count = 1, unshield = 1, token: string = TOKENS[1].address, nullifier = `0x${'11'.repeat(32)}`) {
  let calldata = withdrawalData(count, unshield, recipient, token, nullifier)
  if (CHAIN_ID === 56) {
    const decoded = PROXY.decodeFunctionData('transact', calldata)._transactions
    const transactions: Array<Record<string, unknown> & { boundParams: Record<string, unknown> }> = Array.from(decoded,
      (tx: { toObject(): Record<string, unknown>; boundParams: { toObject(): Record<string, unknown> } }) => ({
      ...tx.toObject(), commitments: [`0x${'34'.repeat(32)}`], boundParams: { ...tx.boundParams.toObject(), chainID: CHAIN_ID },
    }))
    if (count === 1 && unshield === 1 && token !== TOKENS[0].address) {
      const proofType = PROXY.getFunction('transact')!.inputs[0].arrayChildren!
      const ciphertextType = proofType.components!.find((field) => field.name === 'boundParams')!.components!
        .find((field) => field.name === 'commitmentCiphertext')!.arrayChildren!
      transactions.unshift({ ...transactions[0], nullifiers: [keccak256(nullifier)],
        boundParams: { ...transactions[0].boundParams, unshield: 0,
          commitmentCiphertext: [AbiCoder.defaultAbiCoder().getDefaultValue([ciphertextType])[0]] } })
    }
    calldata = PROXY.encodeFunctionData('transact', [transactions])
  }
  return { ...await privateRequest(feesID, publicViewingKey), transactType: 'COMMON', useRelayAdapt: false,
    to: NETWORK.proxyContract, data: calldata,
    minGasPrice: '2000000000' }
}

export async function signedWithdrawalRequest(feesID: string, publicViewingKey: string, recipient: string,
  token: string = TOKENS[1].address, nullifier = `0x${'11'.repeat(32)}`,
  mutate?: (transactions: any[], action: any, account: string) => void) {
  const ephemeral = Wallet.createRandom()
  const common = await withdrawalRequest(feesID, publicViewingKey, recipient, 1, 1, token, nullifier)
  const transactions = Array.from(PROXY.decodeFunctionData('transact', common.data)._transactions, (tx: any, index) => ({
    ...tx.toObject(), nullifiers: Array.from(tx.nullifiers), commitments: Array.from(tx.commitments),
    boundParams: { ...tx.boundParams.toObject(), adaptContract: ephemeral.address, chainID: CHAIN_ID,
      commitmentCiphertext: Array.from(tx.boundParams.commitmentCiphertext) },
    unshieldPreimage: { ...tx.unshieldPreimage.toObject(), token: { ...tx.unshieldPreimage.token.toObject() },
      npk: index === 1 ? zeroPadValue(ephemeral.address, 32) : tx.unshieldPreimage.npk },
  }))
  const action = { ...RelayAdapt7702Helper.getActionData(true, [], 0n), calls: [{ to: ephemeral.address, value: 0n,
    data: ADAPT.encodeFunctionData('transfer', [[{ token: { tokenType: 0, tokenAddress: token, tokenSubID: 0 },
      to: recipient, value: 1000n }]]) }] }
  mutate?.(transactions, action, ephemeral.address)
  const signature = await signExecutionAuthorization(ephemeral, transactions, action, CHAIN_ID,
    { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n })
  const authorization = await ephemeral.authorize({ chainId: CHAIN_ID, nonce: 0, address: NETWORK.relayAdapt7702Contract })
  return { ...common, transactType: 'TX7702', useRelayAdapt: true, to: ephemeral.address,
    authorization: JSON.parse(JSON.stringify(authorization, (_, value) => typeof value === 'bigint' ? value.toString() : value)),
    data: ADAPT.encodeFunctionData('execute', [transactions, action, 0n, signature]) }
}
