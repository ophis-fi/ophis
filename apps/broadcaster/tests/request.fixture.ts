import { AbiCoder, Wallet } from 'ethers'
import { signExecutionAuthorization, RelayAdapt7702Helper, RelayAdapt7702ExecutionType, type TransactionStructV2 } from '@railgun-community/engine'
import { ADAPT, PROXY } from '../src/transaction'
import { NETWORK, VERSION, settings } from '../src/config'
import { withdrawalData } from '../../railgun/tests/withdrawal.fixture'

export const config = settings({ OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_MODE: 'fork',
  OPHIS_BROADCASTER_MARGIN_BPS: '1500',
  OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:8559', OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '10000000000',
  OPHIS_BROADCASTER_MAX_TX_COST_WEI: '10000000000000000', OPHIS_BROADCASTER_RESERVE_WEI: '10000000000000000',
  OPHIS_BROADCASTER_DAILY_BUDGET_WEI: '100000000000000000' })

export async function privateRequest(feesID: string, publicViewingKey: string) {
  const ephemeral = Wallet.createRandom()
  const type = PROXY.getFunction('transact')!.inputs[0].arrayChildren!
  const tx = Array.from(AbiCoder.defaultAbiCoder().getDefaultValue([type])[0])
  tx[type.components!.findIndex((p) => p.name === 'nullifiers')] = [`0x${'12'.repeat(32)}`]
  tx[type.components!.findIndex((p) => p.name === 'commitments')] = [`0x${'34'.repeat(32)}`]
  const transactions = [tx as unknown as TransactionStructV2]
  const action = RelayAdapt7702Helper.getActionData(false, [], 0n)
  const signature = await signExecutionAuthorization(ephemeral, transactions, action, 1,
    { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: 0n })
  const auth = await ephemeral.authorize({ chainId: 1, nonce: 0, address: NETWORK.relayAdapt7702Contract })
  return JSON.parse(JSON.stringify({
    txidVersion: VERSION, chainType: 0, chainID: 1, minVersion: '8.0.0', maxVersion: '8.999.0',
    feesID, broadcasterViewingKey: publicViewingKey, transactType: 'TX7702', useRelayAdapt: true,
    to: ephemeral.address, data: ADAPT.encodeFunctionData('execute', [transactions, action, 0n, signature]),
    gasLimit: '1000000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000',
    authorization: auth, preTransactionPOIsPerTxidLeafPerList: {},
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value)) as Record<string, unknown>
}

export async function withdrawalRequest(feesID: string, publicViewingKey: string, recipient: string, count = 1, unshield = 1) {
  return { ...await privateRequest(feesID, publicViewingKey), transactType: 'COMMON', useRelayAdapt: false,
    to: NETWORK.proxyContract, data: withdrawalData(count, unshield, recipient, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    minGasPrice: '2000000000' }
}
