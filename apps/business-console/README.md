# Ophis Business console

Local only for now: passkey sign-in core and the enrolment and recovery ceremony for members (milestones 1 and 2 of 6). Design, schema, routes and invariants: `ARCHITECTURE.md`.
Never deploy from a laptop, and never run a remote wrangler command from here.

Needs Node 22.18 or later and Google Chrome. Run everything from this folder, with pnpm as `npx -y pnpm@10.34.9`.

```sh
npx -y pnpm@10.34.9 install --ignore-workspace   # the flag is required: without it pnpm installs the root workspace
npx -y pnpm@10.34.9 migrate     # creates the local D1 database (.wrangler/)
npx -y pnpm@10.34.9 seed        # one organisation, one Owner seat; prints a one-time enrolment link (10 minutes)
npx -y pnpm@10.34.9 dev         # builds the app and serves it with the Worker on http://localhost:8787
npx -y pnpm@10.34.9 activate    # first Owner only: local stand-in for the activation by the recovery wallet (milestone 4)
```

Open the enrolment link in Chrome, create the passkey, run `activate`, then sign in at http://localhost:8787.
`seed` writes `.dev.vars` with a fresh random challenge key when the file is missing (see `.dev.vars.example`).

Then, in the app (each person needs their own security key, or a Chrome virtual authenticator per browser profile):
1. Organisation, My passkeys, "Add a passkey". An Owner needs two hardware keys before anything else works.
2. "Invite member" gives a one-time link (10 minutes for key roles, 24 hours for Trader and Viewer). The member opens it on their own device, creates a passkey and reads three words aloud.
3. Under "Waiting for confirmation" the inviter types the words and confirms with a passkey. Key roles need a second key-role member too, or wait 72 hours.
4. "Re-enrol" does the same for a member who lost every passkey. The old passkeys are suspended: for 24 or 72 hours one of them can still sign in to a page with one action, "Stop this replacement".
5. A stop freezes the seat. So does revoking a colleague's last passkey (the button says so). Nothing unfreezes a seat yet: milestone 3.

Word list: EFF short word list 2.0, Creative Commons Attribution 4.0 (`src/server/words.ts`).

Test: `npx -y pnpm@10.34.9 test` (invariant tests in the Workers runtime), `npx -y pnpm@10.34.9 typecheck`, and
`npx -y pnpm@10.34.9 test:e2e` (headless Chrome, three browser contexts with a virtual authenticator each; needs port 8787 free; screenshots in `.shots/`).
