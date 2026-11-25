import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from '@solana/kit';

export interface OphisSolanaChainContext {
  programAddress: Address;
  genesisHash: string;
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
  contextSlot: bigint;
}

/** Unsigned v0 bytes for the wallet; deployment and full cluster identity must match. */
export function compileOphisSolanaWalletTransaction(input: {
  instructions: readonly Instruction[];
  payer: Address;
  programAddress: Address;
  expectedGenesisHash: string;
  context: OphisSolanaChainContext;
}): Uint8Array {
  if (
    input.context.genesisHash !== input.expectedGenesisHash ||
    input.context.programAddress !== input.programAddress
  )
    throw Error('Ophis deployment or wallet network mismatch');
  if (
    !input.instructions.some((instruction) => instruction.programAddress === input.programAddress)
  )
    throw Error('Missing Ophis settlement instruction');
  const message = appendTransactionMessageInstructions(
    input.instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(input.context.blockhash),
        lastValidBlockHeight: input.context.lastValidBlockHeight,
      },
      setTransactionMessageFeePayer(address(input.payer), createTransactionMessage({ version: 0 })),
    ),
  );
  const encoded = getTransactionEncoder().encode(compileTransaction(message));
  if (encoded.length > 1232) throw Error('Wallet transaction exceeds the v0 packet limit');
  return new Uint8Array(encoded);
}
