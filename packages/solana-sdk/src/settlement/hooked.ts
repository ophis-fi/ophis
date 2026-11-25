// This file is automatically loaded by codama for `resolverValueNode` types. For
// cases where the IDL syntax is not enough, custom code can be added to this file
// to retain functionality.

import { getProgramDerivedAddress, type Address } from "@solana/kit";
import { getOrderIntentEncoder, type OrderIntentArgs } from "./generated/index.js";
import IDL from "./generated/idl.json" with { type: "json" };

/**
 * The type definition for the slice of the IDL this file reads.
 */
type SeedBearingIdl = {
  instructions: {
    name: string;
    accounts: {
      name: string;
      pda?: { seeds: { kind: string; value?: number[] }[] };
    }[];
  }[];
};

const SETTLEMENT_SEED: Uint8Array = (() => {
  const idl: SeedBearingIdl = IDL;
  const seed = idl.instructions
    .find((instruction) => instruction.name === "initialize")
    ?.accounts.find((account) => account.name === "state")?.pda?.seeds[0]?.value;
  if (!seed) {
    throw new Error("IDL: initialize's state account has no const seed");
  }
  return new Uint8Array(seed);
})();

// Used to compute the actual order pda address. Needed
// because the middle field is the hash of the intent,
// which is not an operation that can be expressed in IDL.
export async function resolveOrderPda({
  programAddress,
  args,
}: {
  programAddress: Address;
  args: { intent: OrderIntentArgs };
}): Promise<{ value: Address }> {
  const intentBytes = getOrderIntentEncoder().encode(args.intent);
  const orderUid = new Uint8Array(await crypto.subtle.digest("SHA-256", intentBytes));
  const [address] = await getProgramDerivedAddress({
    programAddress,
    seeds: [SETTLEMENT_SEED, orderUid, "order"],
  });
  return { value: address };
}
