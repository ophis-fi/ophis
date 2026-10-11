import {
  AbstractProviderAdapter,
  AddressPerChain,
  type ContractsOrder,
  OrderKind,
  setGlobalAdapter,
  SupportedChainId,
  type UnsignedOrder,
} from '@cowprotocol/cow-sdk'
import { BuyTokenDestination, SellTokenSource } from '@cowprotocol/sdk-order-book'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'

import { createPublicClient, hashTypedData, http } from 'viem'
import { optimism } from 'viem/chains'

import { assertOrderUidMatches } from './assertOrderUidMatches'
import { computeOrderUid } from './computeOrderUid'

const OPTIMISM = 10 as unknown as SupportedChainId
const OPHIS_OP_SETTLEMENT = '0x310784c7FCE12d578dA6f53460777bAc9718B859'
const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER_OWNER = '0x2222222222222222222222222222222222222222'
const ATTACKER = '0x3333333333333333333333333333333333333333'

const ORDER: UnsignedOrder = {
  sellToken: '0x4200000000000000000000000000000000000006',
  buyToken: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  receiver: OWNER,
  sellAmount: '1000000000000000000',
  buyAmount: '3000000000',
  validTo: 2000000000,
  appData: `0x${'ab'.repeat(32)}`,
  feeAmount: '0',
  kind: OrderKind.SELL,
  partiallyFillable: false,
  sellTokenBalance: SellTokenSource.ERC20,
  buyTokenBalance: BuyTokenDestination.ERC20,
}

// Independent reference (same derivation as packages/safe-swap computeOrderUid), pinned to the Ophis OP settlement.
function referenceOphisOpUid(owner: string): string {
  const digest = hashTypedData({
    domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 10, verifyingContract: OPHIS_OP_SETTLEMENT },
    types: {
      Order: [
        { name: 'sellToken', type: 'address' },
        { name: 'buyToken', type: 'address' },
        { name: 'receiver', type: 'address' },
        { name: 'sellAmount', type: 'uint256' },
        { name: 'buyAmount', type: 'uint256' },
        { name: 'validTo', type: 'uint32' },
        { name: 'appData', type: 'bytes32' },
        { name: 'feeAmount', type: 'uint256' },
        { name: 'kind', type: 'string' },
        { name: 'partiallyFillable', type: 'bool' },
        { name: 'sellTokenBalance', type: 'string' },
        { name: 'buyTokenBalance', type: 'string' },
      ],
    },
    primaryType: 'Order',
    message: {
      sellToken: ORDER.sellToken as `0x${string}`,
      buyToken: ORDER.buyToken as `0x${string}`,
      receiver: ORDER.receiver as `0x${string}`,
      sellAmount: BigInt(ORDER.sellAmount),
      buyAmount: BigInt(ORDER.buyAmount),
      validTo: ORDER.validTo,
      appData: ORDER.appData as `0x${string}`,
      feeAmount: BigInt(ORDER.feeAmount),
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    },
  })

  return `${digest}${owner.slice(2).toLowerCase()}${ORDER.validTo.toString(16).padStart(8, '0')}`
}

describe('assertOrderUidMatches', () => {
  beforeAll(() => {
    const provider = createPublicClient({ chain: optimism, transport: http() })
    setGlobalAdapter(new ViemAdapter({ provider }) as AbstractProviderAdapter)
  })

  it('accepts the uid of the reviewed order, owner and Ophis signing domain', async () => {
    const uid = await computeOrderUid(OPTIMISM, OWNER, ORDER as ContractsOrder)

    expect(uid.toLowerCase()).toBe(referenceOphisOpUid(OWNER).toLowerCase())
    await expect(assertOrderUidMatches(uid, ORDER, OPTIMISM, OWNER)).resolves.toBeUndefined()
    await expect(
      assertOrderUidMatches(uid.toUpperCase().replace('0X', '0x'), ORDER, OPTIMISM, OWNER),
    ).resolves.toBeUndefined()
  })

  it('rejects the uid of a different order (e.g. attacker receiver)', async () => {
    const evilUid = await computeOrderUid(OPTIMISM, OWNER, { ...ORDER, receiver: ATTACKER } as ContractsOrder)

    await expect(assertOrderUidMatches(evilUid, ORDER, OPTIMISM, OWNER)).rejects.toThrow(/refusing to presign/)
  })

  it('rejects a uid bound to a different owner', async () => {
    const otherOwnerUid = await computeOrderUid(OPTIMISM, OTHER_OWNER, ORDER as ContractsOrder)

    await expect(assertOrderUidMatches(otherOwnerUid, ORDER, OPTIMISM, OWNER)).rejects.toThrow(/refusing to presign/)
  })

  it('rejects a uid bound to a different chain', async () => {
    const mainnetUid = await computeOrderUid(SupportedChainId.MAINNET, OWNER, ORDER as ContractsOrder)

    await expect(assertOrderUidMatches(mainnetUid, ORDER, OPTIMISM, OWNER)).rejects.toThrow(/refusing to presign/)
  })

  it('rejects a uid bound to a different settlement contract (signing domain)', async () => {
    const otherDomainUid = await computeOrderUid(
      OPTIMISM,
      OWNER,
      ORDER as ContractsOrder,
      {
        [OPTIMISM]: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
      } as AddressPerChain,
    )

    await expect(assertOrderUidMatches(otherDomainUid, ORDER, OPTIMISM, OWNER)).rejects.toThrow(/refusing to presign/)
  })

  it('rejects a non-string uid', async () => {
    await expect(assertOrderUidMatches(undefined as unknown as string, ORDER, OPTIMISM, OWNER)).rejects.toThrow(
      /refusing to presign/,
    )
  })
})
