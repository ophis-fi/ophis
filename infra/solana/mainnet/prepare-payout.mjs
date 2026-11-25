// Offline, unsigned instructions for the configured treasury and its hardware authority.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import profile from '../../../apps/solana/deployment.mainnet.json' with { type: 'json' };
import { getWithdrawNativeSolInstructionAsync } from '../../../packages/solana-sdk/dist/settlement/generated/instructions/withdrawNativeSol.js';
import { getCreateSettlementOwnedOrderInstructionAsync } from '../../../packages/solana-sdk/dist/settlement/generated/instructions/createSettlementOwnedOrder.js';
import { findBufferPda } from '../../../packages/solana-sdk/dist/settlement/generated/pdas/buffer.js';
import { findStatePda } from '../../../packages/solana-sdk/dist/settlement/generated/pdas/state.js';
import { atoms } from '../../../packages/solana-sdk/dist/api.js';

const requireSdk = createRequire(
  new URL('../../../packages/solana-sdk/package.json', import.meta.url),
);
const { address, createNoopSigner } = requireSdk('@solana/kit');
const {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} = requireSdk('@solana-program/token');

export async function preparePayout([mode, ...args]) {
  const authority = createNoopSigner(address(profile.authorities.settlementOwnedOrderAuthority));
  const programAddress = address(profile.programId);
  const treasury = address(profile.treasuryWallet);
  const config = { programAddress };
  let instructions, terms;
  if (mode === 'native' && args.length === 1) {
    const amount = atoms(args[0], true);
    instructions = [
      await getWithdrawNativeSolInstructionAsync(
        { authority, recipient: treasury, amount: BigInt(amount) },
        config,
      ),
    ];
    terms = { requestedLamports: amount };
  } else if (mode === 'spl' && args.length === 5) {
    const [source, target, sell, minimum, expiry] = args;
    const sellMint = address(source),
      buyMint = address(target);
    if (sellMint === buyMint || [sellMint, buyMint].includes('11111111111111111111111111111111'))
      throw Error('Supply two different SPL mints');
    const sellAmount = BigInt(atoms(sell, true)),
      buyAmount = BigInt(atoms(minimum, true));
    const validTo = Number(atoms(expiry, true));
    if (validTo <= Math.floor(Date.now() / 1000) || validTo > 0xffffffff)
      throw Error('Supply a future u32 Unix timestamp');
    const [state] = await findStatePda(config);
    const [sellTokenAccount] = await findBufferPda({ mint0: sellMint }, config);
    const [buyTokenAccount] = await findAssociatedTokenPda({
      owner: treasury,
      mint: buyMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const intent = {
      owner: state,
      sellMint,
      sellTokenAccount,
      buyMint,
      buyTokenAccount,
      sellAmount,
      buyAmount,
      validTo,
      flags: 0,
      appData: new Uint8Array(32),
    };
    instructions = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: authority,
        ata: buyTokenAccount,
        owner: treasury,
        mint: buyMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      await getCreateSettlementOwnedOrderInstructionAsync(
        { authority, createdBy: authority, state, intent },
        config,
      ),
    ];
    terms = {
      sourceMint: sellMint,
      sellAtoms: sell,
      payoutMint: buyMint,
      minimumPayoutAtoms: minimum,
      destination: buyTokenAccount,
      validTo,
    };
  } else {
    throw Error(
      'Usage: prepare-payout.mjs native LAMPORTS | spl SOURCE_MINT PAYOUT_MINT SELL_ATOMS MINIMUM_PAYOUT_ATOMS EXPIRY_UNIX',
    );
  }
  return {
    genesis: profile.genesisHash,
    program: programAddress,
    authority: authority.address,
    treasury,
    ...terms,
    instructions: instructions.map((ix) => ({
      program: ix.programAddress,
      accounts: ix.accounts.map(({ address, role }) => ({ address, role })),
      dataBase64: Buffer.from(ix.data).toString('base64'),
    })),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await preparePayout(process.argv.slice(2)), null, 2));
