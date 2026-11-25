import { address } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
export { TOKEN_PROGRAM_ADDRESS };
export const TOKEN_2022_PROGRAM_ADDRESS = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const SOLANA_NATIVE_ASSET = address('11111111111111111111111111111111');
export const WRAPPED_SOL_MINT = address('So11111111111111111111111111111111111111112');
export type SolanaTokenProgram = typeof TOKEN_PROGRAM_ADDRESS | typeof TOKEN_2022_PROGRAM_ADDRESS;
