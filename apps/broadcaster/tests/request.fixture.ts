import { AbiCoder, Wallet } from 'ethers'
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
  return { ...await privateRequest(feesID, publicViewingKey), transactType: 'COMMON', useRelayAdapt: false,
    to: NETWORK.proxyContract, data: withdrawalData(count, unshield, recipient, token, nullifier),
    minGasPrice: '2000000000' }
}
