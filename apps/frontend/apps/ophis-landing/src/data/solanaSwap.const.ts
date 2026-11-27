// Copy for /swap/solana/: the steps (visible list and HowTo JSON-LD), the fee tiers
// and the questions (accordion and FAQPage JSON-LD). The facts themselves (fee
// wording, venues, stablecoins) live in chains.ts, which names their source code.
import {
  SOLANA_FEE_ANSWER,
  SOLANA_STABLECOIN_LIST as stablecoins,
  SOLANA_VENUE_LIST as venues,
} from './chains'

export const STEPS = [
  {
    name: 'Connect a Solana wallet',
    text: 'Open the Solana swap and connect a browser wallet that supports the Wallet Standard, such as Phantom or Solflare. A mobile wallet can connect by QR code through WalletConnect.',
  },
  {
    name: 'Choose the tokens and the amount',
    text: 'Pick the token you sell and the token you receive. Search by symbol or name, or paste the mint address of a token, then enter the amount you sell.',
  },
  {
    name: 'Review the quote',
    text: 'Check the quoted output, the minimum received, the Ophis fee and the network costs.',
  },
  {
    name: 'Confirm in your wallet',
    text: 'One transaction places your order on Solana with its minimum received. If you sell SOL, the same transaction wraps it.',
  },
  {
    name: 'Receive your tokens',
    text: 'The Ophis solver settles the order on Solana. The receipt links to the settlement on Solana Explorer.',
  },
]

// Fee tiers as checkedQuoteAppData enforces them: the base rate, then the cap on
// the half of the price improvement that Ophis keeps.
export const FEES = [
  { pair: 'Two stablecoins', detail: `Both among ${stablecoins}`, base: '0.01%', cap: '0.20%' },
  { pair: 'SOL and a stablecoin', detail: 'SOL to USDC, or USDT to SOL', base: '0.01%', cap: '0.99%' },
  { pair: 'Every other pair', detail: 'Any other SPL token', base: '0.05%', cap: '0.99%' },
]

export const FAQS = [
  {
    q: 'Can I swap on Solana with Ophis?',
    a: 'Yes. Ophis swaps SOL and SPL tokens natively on Solana in the swap app at swap.ophis.fi. You connect a Solana wallet, review a quote and place one order, and the Ophis solver settles it on Solana at your minimum received or better.',
  },
  {
    q: 'Which Solana DEXes does Ophis route through?',
    a: `The Ophis solver prices ${venues} directly, and can also route through Jupiter. The quote shows the output and the minimum received for your pair and amount before you sign.`,
  },
  { q: 'What does a Solana swap cost on Ophis?', a: SOLANA_FEE_ANSWER },
  {
    q: 'Which wallets can I use to swap on Solana?',
    a: 'Browser wallets that support the Wallet Standard connect directly, such as Phantom and Solflare. A mobile wallet can connect by QR code through WalletConnect. Your keys stay in your wallet: Ophis prepares the order and your wallet signs it.',
  },
  {
    q: 'What happens if my Solana order is not filled?',
    a: 'It stays open until it expires, and you can cancel it in the app. Once it is cancelled or has expired, choose Reclaim account rent and confirm the transaction in your wallet: the deposit paid to open the order account returns to the wallet that paid it. The Ophis program rejects any settlement below your minimum received.',
  },
  {
    q: 'Is a Solana swap on Ophis a bridge?',
    a: 'No. A Solana swap starts and ends on Solana. Moving value between Solana and an EVM chain, or to and from Bitcoin, is a separate cross-chain route in the same app, which uses a deposit flow through NEAR Intents.',
  },
  {
    q: 'Can an AI agent or the Ophis SDK place a Solana order?',
    a: 'Native Solana swaps are available in the swap app. The Ophis MCP server and the @ophis/sdk package build orders for EVM chains only, and the Intent API returns a parsed intent, not an order. None of them builds a Solana order.',
  },
]
