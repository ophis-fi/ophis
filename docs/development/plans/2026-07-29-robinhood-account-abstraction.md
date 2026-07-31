# Robinhood account-abstraction assessment

**Status:** assessed; implementation intentionally gated  
**Scope:** approval and wrap transactions before an Ophis gasless order  
**Chain:** Robinhood Chain mainnet (4663)

## Outcome

Robinhood Chain supports ERC-4337 infrastructure and EIP-7702 delegation, but
Ophis should not turn on sponsored approvals merely because the chain supports
them. An approval sponsor becomes a transaction-policy and abuse-prevention
boundary: it must constrain the token, spender, amount, chain, expiry, and the
order that consumes the approval.

Ophis already keeps the swap order itself gasless. The only candidate operations
for sponsorship are:

1. an exact ERC-20 approval to the verified Robinhood GPv2VaultRelayer;
2. a native-ETH deposit into the verified Robinhood EthFlow contract;
3. an approval reset required by a non-standard token.

Safe users already have a reviewed bundle path. Do not replace it with a new
smart account flow.

## Required policy

A future paymaster request must fail closed unless all of these are true:

- `chainId === 4663`;
- the spender is
  `0xB52C38097c19cd38238c62DD36027a7918eFa890` (Ophis Robinhood
  GPv2VaultRelayer) or the call is to
  `0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29` (Ophis Robinhood EthFlow);
- the token is the exact sell token in a live Ophis quote;
- the approval amount is exact or bounded to the signed order amount—never
  unlimited;
- the receiver remains the signer unless the existing receiver policy explicitly
  allows otherwise;
- calldata is decoded server-side and reconstructed from typed fields rather
  than relayed as arbitrary bytes;
- the sponsorship expires with the quote and is single-use;
- per-wallet, per-IP, per-token, and global spend budgets are enforced by an
  atomic edge primitive;
- the paymaster/bundler endpoint and sponsor identity are configured as
  deployment secrets, never shipped in the client;
- simulation succeeds against the same supervised Robinhood RPC used by the
  production solver stack.

## Rollout gates

1. Select a bundler/paymaster provider and document its availability, privacy,
   rate limits, and failure behavior.
2. Deploy a staging-only policy endpoint with zero-value simulation.
3. Add adversarial tests for spender substitution, calldata smuggling, replay,
   stale quotes, chain substitution, and budget races.
4. Run a time-boxed testnet canary.
5. Commission a focused security review of the sponsorship policy.
6. Enable behind a server-side feature flag with a hard daily budget and
   immediate kill switch.

Until those gates are met, the application correctly tells users that swaps are
gasless while approvals and wrapping require ETH. No speculative delegation or
paymaster permission is added to production.
