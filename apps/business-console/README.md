# Ophis Business console

Local only for now: passkey sign-in core, the enrolment and recovery ceremony for members, roles with two-person approval and the audit log, wallets with the recovery wallet, and last-Owner recovery (milestones 1 to 4 of 6). Design, schema, routes and invariants: `ARCHITECTURE.md`.
Never deploy from a laptop, and never run a remote wrangler command from here.

Needs Node 22.18 or later and Google Chrome. Run everything from this folder, with pnpm as `npx -y pnpm@10.34.9`.

```sh
npx -y pnpm@10.34.9 install --ignore-workspace   # the flag is required: without it pnpm installs the root workspace
npx -y pnpm@10.34.9 migrate     # creates or updates the local D1 database (.wrangler/); run it again after pulling: milestone 3 adds 0002, milestone 4 adds 0003 and 0004
npx -y pnpm@10.34.9 seed        # one organisation, one Owner seat; prints a one-time enrolment link (10 minutes)
npx -y pnpm@10.34.9 dev         # builds the console and the signing page, and serves both with the Worker: console http://localhost:8787, signing page http://127.0.0.1:8787/sign/
npx -y pnpm@10.34.9 activate    # first Owner only: local stand-in for the activation by the recovery wallet (milestone 5)
npx -y pnpm@10.34.9 skip        # local stand-in for the passing of time: every wait that runs is over (recovery wallet 72 h, recovery request, 24 h after a cancel)
```

Open the enrolment link in Chrome, create the passkey, run `activate`, then sign in at http://localhost:8787.
`seed` writes `.dev.vars` with a fresh random challenge key when the file is missing (see `.dev.vars.example`).

Then, in the app (each person needs their own security key, or a Chrome virtual authenticator per browser profile):
1. Organisation, My passkeys, "Add a passkey". An Owner needs two hardware keys before anything else works.
2. "Invite member" gives a one-time link (10 minutes for key roles, 24 hours for Trader and Viewer). The member opens it on their own device, creates a passkey and reads three words aloud.
3. Under "Waiting for confirmation" the inviter types the words and confirms with a passkey. Key roles need a second key-role member too. Only an organisation that has had no other key-role member in the last 30 days waits 72 hours instead (locally, `activate` stands in for that wait).
4. "Re-enrol" does the same for a member who lost every passkey. The old passkeys are suspended: for 24 or 72 hours one of them can still sign in to a page with one action, "Stop this replacement".
5. A stop freezes the seat. An Owner or Admin can also freeze a seat at once: Members and roles, "Manage", "Freeze seat". A frozen member who signs in sees who froze the seat and when; a replaced passkey can still stop its replacement on a frozen seat. A member's last passkey is never revoked.
6. Unfreezing a seat, removing a member, changing a role and changing the passkey rule for key roles take two people: one asks ("Manage", or the passkey rule section), a different member with a key role approves under "Approvals" after a passkey check. Each button is preceded by what it will do.
7. Compliance (Owner, Compliance officer, Viewer): the audit log in plain words with both hashes per row, "Chain verified" computed by the server, and "Export CSV".
8. Two passkeys of one seat need different names. If the local database already holds two with the same name, `migrate` fails: delete `.wrangler/` and seed again.
9. Wallets (Organisation, Wallets): an Owner or Admin uses "Link a wallet" and gets a signing link, valid 7 days. Nothing is stored yet. The link opens the signing page on its own address (`http://127.0.0.1:8787/sign/` locally), in the browser that holds the wallet. The wallet signs one typed message that names the organisation. A wallet with one key, or a custodian's browser extension, signs through the browser. A Safe signs inside the Safe interface (below).
10. With colleagues in key roles the link then waits under "Approvals" for a different member. An organisation with a single key-role member links at once. "Manage" on a wallet: "Unlink" (one person; never the recovery wallet), "Set as recovery wallet" (an Owner asks, a second person approves, in force 72 hours later), "Cancel change" (any Owner, during the 72 hours).
11. Security and data, for an Owner: "Recovery readiness" says Ready, At risk with the next step, or Not recoverable. A Safe that is the recovery wallet is read on the chain at that moment: green needs a genuine Safe (official proxy code, singleton and fallback handler), a threshold of 2 or more, no module, and the owners it had when it was approved. A contract that only answers like a Safe is stored as a single key. Below it: the recovery sheet, with "Print the recovery sheet".
12. Last-Owner recovery, when no Owner can sign in. Open http://localhost:8787/recover (no sign-in), enter the organisation id from the recovery sheet and create a passkey on a new security key. The page shows three words and a signing link. The signers of the recovery wallet open the link on the signing page, compare the organisation id and the three words, and sign. Then the request waits 72 hours (`skip` locally). Every member sees a banner at sign-in: an Owner can cancel after a passkey check, an Admin, Approver or Compliance officer can add 72 hours once, and the recovery wallet can cancel by signing (the form on /recover, with the request number from the banner). After the wait, "Continue with the new passkey" on /recover makes the requester an Owner. For 7 days the organisation is in quarantine and a replaced Owner passkey, used at sign-in, can stop the recovery. The next request can start 24 hours after a cancel, and not while a completed recovery can still be stopped (7 days, or until it is stopped).
13. An override ("Override the Owners" on /recover) works only for a green recovery wallet, within 30 days of an Owner cancelling or stopping a recovery. No Owner can cancel or stop it.

Dry run with a real Safe (not yet tried inside the real Safe interface; `test:chain` proves the server side against a real Safe 1.4.1 on a fork):
1. Run `dev`, sign in as an Owner with two keys, and use "Link a wallet" with the Safe's address and its chain (Ethereum, OP Mainnet, Base or Arbitrum One). Copy the signing link.
2. In the Safe interface (https://app.safe.global), open the Safe, then Apps, "My custom apps", "Add custom app", and enter `http://127.0.0.1:8787/sign/`. The interface reads `manifest.json` from there.
3. Open the app and paste the request code (the whole link works) into the box. Compare the action, site, organisation id, chain, wallet and expiry with the console.
4. Press "Sign with this Safe". Offchain: each owner signs the message in the Safe interface, with this window left open, and the page posts the result by itself. If the Safe is set to sign onchain: execute the transaction, then press "Check again".
5. Back in the console the wallet shows as "Safe 2 of 3" (or its own numbers), pending or linked. Set it as the recovery wallet and read "Recovery readiness" 72 hours later, or see amber "in force from" at once.

Word list: EFF short word list 2.0, Creative Commons Attribution 4.0 (`src/server/words.ts`).

Test: `npx -y pnpm@10.34.9 test` (builds, then the invariant tests in the Workers runtime, with a stubbed JSON-RPC for the two endpoints and real signatures from the public anvil test keys), `npx -y pnpm@10.34.9 typecheck`,
`npx -y pnpm@10.34.9 test:chain` (on demand, needs the network, `anvil` and Node 24 or later: forks OP Mainnet on port 8546, creates a Safe through every official proxy factory and compares it with the allow-list, checks the verifier and the Safe reads on a real 2 of 3 Safe 1.4.1, and runs a whole recovery through the Worker on a throwaway local database), and
`npx -y pnpm@10.34.9 test:e2e` (headless Chrome, one browser context per person with a virtual authenticator each; needs port 8787 free; screenshots in `.shots/`).

Support (milestone 6): the rail entry and the top button open `#/support`. The Worker needs the secret `TYPESAFE_API_KEY`: add the line `TYPESAFE_API_KEY=...` to `.dev.vars` (git-ignored; never commit or print it). Without it every question gets the hand-over card.
`npx -y pnpm@10.34.9 test:jev` (on demand, needs the network and `TYPESAFE_API_KEY` in the environment): sends the 32 questions of the prototype through the server's own functions and prints each outcome, the accuracy and the median latency, never the key.
`test:e2e` includes the Support flow; with the key in `.dev.vars` that part needs the network too.
