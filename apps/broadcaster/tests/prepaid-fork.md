# Isolated prepaid proof qualification

The cross-workspace fixture uses both client and server dependencies. From `apps/broadcaster`, install each locked dependency tree and typecheck it separately from the standalone broadcaster build:

```sh
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm --dir ../railgun install --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm exec tsc --noEmit -p tsconfig.fork.json
```

Run with Node 22:

```sh
node --max-old-space-size=4096 tests/prepaid-fork-roundtrip.mjs
```

Select BNB explicitly, with a public-state read RPC whose chain ID is 56:

```sh
OPHIS_PREPAID_TEST_CHAIN_ID=56 \
OPHIS_PREPAID_TEST_UPSTREAM=https://YOUR_TRUSTED_BNB_READ_RPC \
node --max-old-space-size=4096 tests/prepaid-fork-roundtrip.mjs
```

Use separate sequential processes for the two chains. The launcher fixes both the backend environment and client compile-time chain; it rejects a conflicting preexisting broadcaster chain. On another host, set `OPHIS_PREPAID_TEST_EVIDENCE` to a private task directory and `OPHIS_PREPAID_TEST_ANVIL` to its verified Anvil executable. Node 22, Anvil with Prague support, `ps`, and `lsof` are required. Apply host resource limits independently; the launcher disk reserve alone is not a memory or CPU limit.

This separate fixture never attaches to an existing Anvil or owner browser. It starts a new loopback Anvil, pins the current finalized upstream block, and verifies its PID, UID, listener, process start identity, fork block, chain, and instance ID before local mutations. The default read-only upstream is the existing Ophis Ethereum endpoint; `OPHIS_PREPAID_TEST_UPSTREAM` can select another public-state RPC. `OPHIS_PREPAID_TEST_FORK_BLOCK` optionally pins an explicit available snapshot. No transaction is sent to that upstream.

The runner uses newly generated synthetic keys, a fresh SDK database, and in-memory public proving artifacts. Synthetic state is removed when the invocation exits; evidence retains process metadata, results, phase/failure details, compiled fixture, and node logs. `OPHIS_PREPAID_TEST_EVIDENCE` and `OPHIS_PREPAID_TEST_ANVIL` select the evidence directory and absolute Anvil executable. It enforces the existing 6 GiB free-space reserve and stops its owned node before that reserve is exhausted. Anvil keeps at most 64 persisted historical states in the invocation's private temporary directory, which is removed during cleanup; disabling RPC storage caching alone does not bound those states. Keep additional headroom for the public Merkle tree and the operating system's memory swap.

The intended acceptance sequence is:

1. Local synthetic native shield, then a real private wrapped-native top-up proof with the exact credit memo.
2. Actual encrypted backend claim and duplicate claim, using real view-only note, ciphertext, canonical receipt, finality, and backing validation.
3. Real fee-free EIP-7702 swap proof, guarded backend signature, private sender redirected only to the owned fork, and exact request replay without another signature.
4. Real fee-free USDC withdrawal proof and public recipient balance verification. Ethereum uses its COMMON proof path. BNB uses the SDK cross-contract proof, re-signs `requireSuccess=true`, and verifies the existing client bound-withdrawal validator accepts exactly one principal proof with the exact recipient and net transfer.
5. One additional real wrapped-native withdrawal proof passes backend validation and execution tracing. After durable signing, change only the owned fork's proxy bytecode to force an included revert, then an included out-of-gas failure. Restore the code after each receipt. Both attempts must charge the exact actual gas plus the quoted allowance/margin, stay within the signed cap, release the unused hold, preserve private principal and keep remaining credit backed. Exact request replay must not sign or charge again.
6. Real memo-less owner private refund: save its owner intent with canonically verified accounted backing before sending. It must not settle before the owner associates its finalized receipt; exact outgoing-note, owned-input and change verification must settle the refund and release its hold.
7. Real owner collection of settled execution charges **and completed refund fees**, consuming exactly one real accounted input note under a saved owner intent. Include a real private broadcaster-fee output and verify its recipient balance; the full earned debit must equal the private fee plus gross unshield. Generate the binding with the pinned ANON gateway's `getAdaptParams`, then generate a real proof and call `unshield` with native conversion. The native proceeds, after the pool unshield fee and pinned ANON gateway fee, must reach the broadcaster directly; the production trace and owned-debit verifiers must settle the collection journal. Check that native proceeds cover measured execution, refund and collection gas plus the configured margin on those costs and the private fee. The private fee is already deducted before native proceeds are calculated. Remaining customer credit must stay privately backed throughout.

The accelerated batch respects the production owner query limit: after the duplicate claim and four execution quotes, it waits for that real one-minute refresh window to expire before preparing the owner refund. It does not mock the clock or increase the allowance.

The result starts with `passed:false` and `proofsCompleted:0`; a complete run generates six proofs and submits four broadcaster operations. The same additional withdrawal proof is used for both failures, with separate authenticated quotes, because neither failed transaction spends its nullifiers. The synthetic top-up is 0.01 WETH or 0.002 WBNB, received as one note to qualify the initial single-input owner route. Owner intents explicitly select the measured one-input, three-output, one-proof limits; the final collection must actually consume one note with fee, change and unshield outputs. Owner refund and collection use the existing maximum gas price and per-transaction cost caps. A fresh synthetic public payer has no inherited EIP-7702 delegation and pays those owner operations without advancing the broadcaster nonce; its native costs are included in combined economics. The native accounting excludes user-paid shielding/top-up and guard commissioning; those are separately funded test setup, not broadcaster execution revenue. No mock proof, fabricated receipt, skipped SDK scan, or manually inserted credit substitutes for acceptance. Fault injection deliberately models failure after simulation; it does not claim that a live private relay would include those failing transactions or that the real proxy can be changed this way.

BNB uses WBNB for the shield, fee top-up, collection, and refund. Its USDC has 18 decimals, versus 6 on Ethereum; the runner reads and checks both principal and wrapped-token decimals on its owned snapshot before mutation. BNB uses the prepared pilot gas caps (0.1 gwei, 0.00025 BNB per transaction, 0.00045 BNB daily, 0.0175 BNB reserve) and a modeled 0.05 gwei execution price. The Prague simulator uses a 1 wei base fee and disables Anvil's default 1 gwei priority-fee floor; this models bounded EVM execution, not BNB's live fee oracle or consensus. The fixture asserts its suggested price remains positive and within the unchanged operator cap. These fixture settings do not enable mainnet admission. A proof whose estimated gas exceeds those caps must fail instead of widening them.

The real protected sender constructs and journals its fixed relay request. The fixture validates the canonical BNB bundle with no reverting hashes and no merge, then forwards its exact signed bytes only to the owned local node. Its synthetic builder acknowledgment is distinct from the transaction hash. Small transport regressions can run without any fork or SDK history scan:

```sh
node node_modules/vitest/vitest.mjs run tests/prepaid-fork-transport.test.ts
```

Implementing or compiling either chain path does not establish proof acceptance. Only that chain's completed `result.json` with `passed:true` does. The runner does not establish live private-relay inclusion, live finality, PPOI, production-history restore, or live owner-wallet interoperability. Local finality is modeled by owned-node block mining. It records the actual collection nullifier count and gas; the one-input shape is not a universal bound for fragmented fee-wallet collections. Its combined four-attempt/refund batch also does not establish that the same allowance covers a refund-only customer. Each owner payout needs its complete cost preflight, including later conversion of the retained wrapped-native fee. Public Merkle history remains necessary for root verification even though newly generated wallets have accurate creation blocks.
