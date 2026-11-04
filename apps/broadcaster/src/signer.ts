import { getAddress, Transaction, type TransactionLike, type TransactionRequest } from 'ethers'

export interface GasSigner {
  readonly address: string
  signTransaction(transaction: TransactionRequest): Promise<string>
}

export async function signApprovedTransaction(signer: GasSigner, transaction: TransactionLike<string>): Promise<string> {
  const operator = getAddress(signer.address)
  if (transaction.from != null && getAddress(transaction.from) !== operator)
    throw new Error('The approved sender does not match the configured signing account.')
  const approved = Transaction.from({ ...transaction, from: undefined, signature: undefined }).unsignedSerialized
  const raw = await signer.signTransaction(transaction)
  const signed = Transaction.from(raw)
  if (signed.from !== operator || signed.unsignedSerialized !== approved)
    throw new Error('The signer returned a transaction different from the approved execution.')
  return raw
}
