# Ophis Business console

Local only for now: passkey sign-in core (milestone 1 of 6). Design, schema, routes and invariants: `ARCHITECTURE.md`.
Never deploy from a laptop, and never run a remote wrangler command from here.

Needs Node 22.18 or later and Google Chrome. Run everything from this folder, with pnpm as `npx -y pnpm@10.34.9`.

```sh
npx -y pnpm@10.34.9 install --ignore-workspace   # the flag is required: without it pnpm installs the root workspace
npx -y pnpm@10.34.9 migrate     # creates the local D1 database (.wrangler/)
npx -y pnpm@10.34.9 seed        # one organisation, one Owner seat; prints a one-time enrolment link (10 minutes)
npx -y pnpm@10.34.9 dev         # builds the app and serves it with the Worker on http://localhost:8787
npx -y pnpm@10.34.9 activate    # local stand-in for the confirmation ceremony: the stored passkey becomes active
```

Open the enrolment link in Chrome, create the passkey, run `activate`, then sign in at http://localhost:8787.
`seed` writes `.dev.vars` with a fresh random challenge key when the file is missing (see `.dev.vars.example`).

Test: `npx -y pnpm@10.34.9 test` (invariant tests in the Workers runtime), `npx -y pnpm@10.34.9 typecheck`, and
`npx -y pnpm@10.34.9 test:e2e` (headless Chrome with a virtual authenticator; needs port 8787 free; screenshots in `.shots/`).
