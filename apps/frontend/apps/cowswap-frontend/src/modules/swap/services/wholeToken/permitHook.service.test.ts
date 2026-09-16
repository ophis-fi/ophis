import { COW_PROTOCOL_VAULT_RELAYER_ADDRESS } from '@cowprotocol/common-utils'
import { PERMIT_HOOK_DAPP_ID } from '@cowprotocol/hook-dapp-lib'
import { Interface } from '@ethersproject/abi'

import { isReplaceableCowPermit } from './permitHook.service'
import { USDC, WETH } from './router.service'

const abi = new Interface(['function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'])
const owner = '0x1111111111111111111111111111111111111111'
const callData = (spender: string): string =>
  abi.encodeFunctionData('permit', [
    owner,
    spender,
    100,
    2000000000,
    27,
    '0x' + '00'.repeat(32),
    '0x' + '00'.repeat(32),
  ])
const hook = {
  target: USDC,
  dappId: PERMIT_HOOK_DAPP_ID,
  gasLimit: '80000',
  callData: callData(COW_PROTOCOL_VAULT_RELAYER_ADDRESS[1]),
}

it('recognizes only a CoW input permit that direct approvals replace', () => {
  expect(isReplaceableCowPermit(hook, USDC)).toBe(true)
  expect(isReplaceableCowPermit(hook, WETH)).toBe(false)
  expect(isReplaceableCowPermit({ ...hook, target: WETH }, USDC)).toBe(false)
  expect(isReplaceableCowPermit({ ...hook, dappId: 'custom' }, USDC)).toBe(false)
  expect(isReplaceableCowPermit({ ...hook, callData: callData(owner) }, USDC)).toBe(false)
  expect(isReplaceableCowPermit({ ...hook, callData: '0xa9059cbb' }, USDC)).toBe(false)
})
