// EVM schema: @relay-protocol/settlement-sdk 0.0.156, dist/order/index.js.
export const RELAY_ORDER_TYPES = {
  Order: [
    {
      name: 'version',
      type: 'string',
    },
    {
      name: 'solverChainId',
      type: 'string',
    },
    {
      name: 'solver',
      type: 'address',
    },
    {
      name: 'salt',
      type: 'uint256',
    },
    {
      name: 'inputs',
      type: 'Input[]',
    },
    {
      name: 'output',
      type: 'Output',
    },
    {
      name: 'fees',
      type: 'Fee[]',
    },
  ],
  Input: [
    {
      name: 'payment',
      type: 'InputPayment',
    },
    {
      name: 'refunds',
      type: 'InputRefund[]',
    },
  ],
  InputPayment: [
    {
      name: 'chainId',
      type: 'string',
    },
    {
      name: 'currency',
      type: 'bytes',
    },
    {
      name: 'amount',
      type: 'uint256',
    },
    {
      name: 'weight',
      type: 'uint256',
    },
  ],
  InputRefund: [
    {
      name: 'chainId',
      type: 'string',
    },
    {
      name: 'recipient',
      type: 'bytes',
    },
    {
      name: 'currency',
      type: 'bytes',
    },
    {
      name: 'minimumAmount',
      type: 'uint256',
    },
    {
      name: 'deadline',
      type: 'uint32',
    },
    {
      name: 'extraData',
      type: 'bytes',
    },
  ],
  Output: [
    {
      name: 'chainId',
      type: 'string',
    },
    {
      name: 'payments',
      type: 'OutputPayment[]',
    },
    {
      name: 'deadline',
      type: 'uint32',
    },
    {
      name: 'calls',
      type: 'bytes[]',
    },
    {
      name: 'extraData',
      type: 'bytes',
    },
  ],
  OutputPayment: [
    {
      name: 'recipient',
      type: 'bytes',
    },
    {
      name: 'currency',
      type: 'bytes',
    },
    {
      name: 'minimumAmount',
      type: 'uint256',
    },
    {
      name: 'expectedAmount',
      type: 'uint256',
    },
  ],
  Fee: [
    {
      name: 'recipientChainId',
      type: 'string',
    },
    {
      name: 'recipient',
      type: 'bytes',
    },
    {
      name: 'currencyChainId',
      type: 'string',
    },
    {
      name: 'currency',
      type: 'bytes',
    },
    {
      name: 'amount',
      type: 'uint256',
    },
  ],
}
