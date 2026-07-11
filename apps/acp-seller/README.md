# Ophis ACP seller handler

A small always-on service that makes Ophis **hireable on Virtuals Protocol
ACP**. It listens for ACP jobs, and for each one it builds a bounded,
ready-to-sign Ophis swap order and delivers it as the job deliverable. The
buyer agent signs the delivered order with its own key and submits it, so
**Ophis never holds keys** at any point in the flow.

Status: **scaffold, not deployed.** The code is complete and reviewable; the
manual steps below (whitelisted wallet, entity id, Job offering, hosting) are
required before it can run.

## Why this exists

The Ophis ACP agent is registered (id `019f28b9-...`) with a free Resource
offering, but ACP buyer discovery keys off **Job** offerings, not Resources, so
Ophis is invisible to hiring agents today. A seller Job handler plus a Job
offering makes Ophis discoverable and hireable.

## How it maps ACP to Ophis

| ACP phase | What the handler does |
| --- | --- |
| REQUEST | Parse the buyer requirement as a swap request (sell token, buy token, amount, chain, the buyer's own receiving address). Accept if it parses; otherwise reject with a reason. |
| TRANSACTION (buyer paid) | Call the Ophis order-build path: fetch a live quote from the chain's Ophis orderbook, apply slippage, embed the Ophis partner fee, pin the receiver to the buyer, and deliver `{ order, signing, fullAppData, appDataHash }`. |
| EVALUATION | The buyer (or an evaluator agent) checks the deliverable is a well-formed, limit-bounded order for the requested pair. |

The deliverable is a signable order, not a settled trade. The buyer signs it
with its own key (the ACP agent wallet or any signer it controls) and submits
it to the orderbook, or relays it through the Ophis MCP `submit_order` tool.
This keeps the keyless-venue guarantee intact.

## Key custody (the important part)

The handler does **not** need the Ophis agent's Privy embedded-wallet key. ACP
signs job-lifecycle transitions with a **separate whitelisted wallet**: you
generate a fresh key, whitelist it against the Ophis agent in the Virtuals
dashboard, and the handler uses only that key. It authorizes ACP protocol
actions (accept / deliver) on Base for the agent; it never touches user funds
and never signs swap orders.

## Prerequisites (manual, one-time)

1. **Whitelisted signer wallet.** Generate a key (`cast wallet new`), store it
   in the macOS keychain as `ophis-acp-whitelisted-signer`, and whitelist its
   address against the Ophis agent in the Virtuals dashboard
   (app.virtuals.io, the agent's Wallet / Whitelist section). Never commit it.
2. **Entity id.** Read the Ophis agent's numeric ACP entity id from the
   dashboard (distinct from the agent UUID). Set `OPHIS_ACP_ENTITY_ID`.
3. **Agent wallet address.** The registered agent EVM address. Set
   `OPHIS_ACP_WALLET_ADDRESS`.
4. **Job offering.** Create a Job offering for the agent in the dashboard (or
   via the ACP API): name it e.g. "Bounded MEV-protected swap order", price it
   (offerings can be low or zero), and describe the required inputs (sell
   token, buy token, amount, chain, receiver). This is what buyer discovery
   indexes.
5. **Gas.** ACP job-lifecycle txs run on Base. Confirm whether the agent's
   Base gas is sponsored (registration was); if not, fund the whitelisted
   wallet with a small amount of Base ETH. Flagged as a cost to confirm.
6. **Host.** Run the process on the rebates VM (Debian, already runs Node
   services) under a systemd unit or pm2. It is a light poller.

## Run

```bash
npm install
cp .env.example .env   # fill in the values above (key from keychain at deploy)
npm run start
```

`npm run start` loads `apps/acp-seller/.env` automatically: the script runs
`tsx --env-file=.env src/index.ts`, so the values are in `process.env` before
the handler reads them. There is no `dotenv` dependency. `.env` is gitignored;
never commit a real one.

## Files

- `src/index.ts`: the seller loop (poll ACP jobs, accept, build, deliver).
- `src/buildOrder.ts`: the Ophis order-build bridge (orderbook quote plus
  `@ophis/sdk` helpers; reuses the documented SDK integration path).
- `.env.example`: the required configuration.

## ACP SDK

This handler uses `@virtuals-protocol/acp-node` (the phase-based SDK) and its
`AcpContractClientV2` client. The "V2" there is the ACP on-chain contract
version, not the npm package version: `AcpContractClientV2` is exported from
`@virtuals-protocol/acp-node`, not from a separate package.

There is a distinct `@virtuals-protocol/acp-node-v2` package (a ground-up,
event-driven rewrite around `AcpAgent` and `JobSession`). We do NOT use it: it
is a different API that would mean rewriting the poll/accept/deliver loop. The
verify was against the package README on GitHub
(github.com/Virtual-Protocol/acp-node): `AcpContractClientV2`, `AcpClient`, and
`AcpJobPhases` all live in `@virtuals-protocol/acp-node`.

The dependency is pinned to `0.3.0-beta.40` (the current `latest` dist-tag). The
package publishes only prereleases, so a caret range such as `^0.2.0` resolves
to nothing and a caret over a prerelease can jump to an unrelated branch build;
an exact pin keeps installs reproducible. Because acp-node ships a CommonJS
bundle, `src/index.ts` reads the default-exported `AcpClient` class as
`pkg.default` (a bare `import AcpClient from` binds to the module namespace under
Node's ESM interop, not the class).

## Not done here

- Creating the Job offering (dashboard/API step, needs the account).
- Whitelisting the signer wallet (dashboard step).
- Deployment (needs the above plus a hosting decision).
