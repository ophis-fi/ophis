# Business console: production runbook

Everything needed to run and update pro.ophis.fi. Live since 2026-11-17. Commands run from `apps/business-console` on the operator's Mac, with `npx -y pnpm@10.34.9` for the `operator` commands. Nothing here is ever pasted into a chat, an issue or a commit: every secret goes in on stdin or at a hidden prompt.

## What runs where

| Part | Where |
|---|---|
| Console | https://pro.ophis.fi (passkeys are tied to this name: it never changes) |
| Signing page | https://sign.ophis.fi/sign/ (the root answers 404 on purpose) |
| Operator API | https://operator.ophis.fi, behind Cloudflare Access (team `oclawd`, AUD in `wrangler.jsonc`) |
| Worker | `ophis-business-console-production`, Cloudflare account `4761b41ef352631db0ed367fea98ffdc` |
| Database | D1 `ophis-business`, id `c5d7d56e-ddd5-4788-8008-7089aa7f2a0b`, jurisdiction `eu`. Sealed files live here too (`sealed_chunks`) |
| Daily run | Cron `17 3 * * *` (UTC): order states, partner figures |
| Partner figures | https://rebates.ophis.fi (the rebate indexer on Cadia), read with `INDEXER_TOKEN` |

**Free plans only (owner, 2026-11-17).** Workers Free, D1 Free, Zero Trust Free, Turnstile. They refuse past a limit; they never bill. Never enable R2 or any pay-as-you-go product for this console.

## Secrets (Worker, `--env production`)

| Secret | Copy kept in | Made by / rotated with |
|---|---|---|
| `CHALLENGE_KEY` | Keychain `ophis-console-challenge-key` | Random 32 bytes. Rotating ends pending invitations, sign-ins and applications in progress |
| `INDEXER_TOKEN` | Keychain `business-api-token` | The same value as `BUSINESS_API_TOKEN` in Cadia `/srv/ophis/apps/rebate-indexer/.env`. Change both together |
| `OPERATOR_TOKEN` | Keychain `ophis-operator-token` | `operator token --production` (new token, Keychain and Worker at once) |
| `OPERATOR_EMAIL` | the operator's Cloudflare login email | The review page (2026-11-19): the email Access signs in must be this one. Set with `npx wrangler secret put OPERATOR_EMAIL --env production` (hidden prompt). Not set: the page is refused, the command still works |
| `TURNSTILE_SECRET` | Cloudflare (Turnstile, widget of pro.ophis.fi) | Rotate there, then `npx wrangler secret put TURNSTILE_SECRET --env production` (hidden prompt) |
| `TYPESAFE_API_KEY` | not set | Without it Support answers every question with the hand-over card |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Keychain `ophis-telegram-bot`; the chat is the owner's | One message to the owner each time an application is submitted for review (2026-11-17). Without them nothing is sent |

`npx wrangler secret list --env production` names them. Set several from the Keychain without printing them: build the JSON in a process and pipe it to `npx wrangler secret bulk --env production`.

## Updating the console

1. Branch from `origin/main`, change, test: `typecheck`, `test` (unit), `test:e2e` (browser). In a fresh worktree the first `test:e2e` fails at "the page names the key it seals to": the build ran before `seed` wrote `.env.local`. Run it again.
2. A new migration (`migrations/00NN_*.sql`): apply it to production BY HAND before the merge, because the CI token cannot touch D1. Until the merge deploys, the Worker already running uses the new schema, so the migration must keep every read and write of that Worker working: add tables, nullable or defaulted columns, plain indexes; no new constraint its writes could break (a unique index, a CHECK, a NOT NULL column without a default); never drop or rename what it uses. A removal or a new constraint waits for a later release, after the Worker that needs it has deployed.
   `npx wrangler d1 migrations apply ophis-business --remote --env production`, then check with `npx wrangler d1 migrations list ophis-business --remote --env production` ("No migrations to apply").
   After a migration is applied to production, never edit its file: Wrangler records only the file name, so an edited file is skipped and the check above still passes. Put any further change in a new `migrations/00NN_*.sql` file (CodeRabbit, PR #1652).
3. PR. Required: CI green, the "fresh Codex review" gate (a Codex review of the exact head: comment `@codex review`, then `Head: <sha>` and `Base: <sha>` on their own lines), every review thread resolved. Mind D1's limits: 2,000,000 bytes per string or row, 50 queries per request, 10 ms of CPU; bytes bound to D1 become an Array of numbers in the Worker, so pass large binary data as hex text (`unhex(?)`, `hex(data)`).
4. Merge: `.github/workflows/business-console-deploy.yml` deploys on main with `CLOUDFLARE_WORKERS_TOKEN`. Secrets stay as they are.
5. Check: `curl -s -o /dev/null -w '%{http_code}' https://pro.ophis.fi/` (200), `https://sign.ophis.fi/sign/` (200), `https://operator.ophis.fi/` (302 to Access); `operator list --production`.

`npx wrangler login` on the Mac when wrangler says the login expired: a Cloudflare page opens, press Allow.

## Passkeys

Since 2026-11-17 an organisation made by an application allows passkeys that sync (a computer, a phone) for every key role, Owners included; an Owner can require hardware security keys under Organisation, "Passkey rule for key roles" (a two-person change). Organisations made before keep hardware keys only.

## The operator's commands

The review page (2026-11-19): https://operator.ophis.fi/ , behind the same Cloudflare sign-in. It lists what is under review with what to compare, every organisation (its kind, state, active members and next review), reviews due, frozen organisations and the loaded lists, and records Approve (with the list files of the screening, hashed in the browser: only their SHA-256 is sent), Ask for more and Refuse, and makes invitation codes. It holds no token: the Worker takes the email Access signed, which must be `OPERATOR_EMAIL`. The Telegram message of each application links to it. The rest (freeze, unfreeze, screen, addresses, items, get) is the command's. On the Mac, `operator` alone lists (`~/.local/bin/operator`).

The first command of a day opens a Cloudflare Access sign-in (cloudflared, valid 24 hours). The link also works from a phone; it waits about 6 minutes. On success cloudflared prints the token: never paste that output anywhere.

- `operator list --production`: what is under review, reviews due, frozen organisations, and the loaded lists with their dates.
- `operator invite --production`: an invitation code for a new client, 12 characters like `7K3M-Q9TX-4BDA`, one use, valid 48 hours. Make it just before you send it.
- `operator decide <id> approve|more|refuse ... --production`, `operator freeze|unfreeze <id> --production`, `operator items <id> --production`, `operator get <item id> --reason kyb_review --out item.age --production`: README, "Onboarding" and "Sealed declaration".

`operator reporting <organisation id> exclude --wallet <address> --production` removes a linked address from partner reporting across chains; `include` restores it. This records an audit entry and preserves wallet linking, recovery, trading, linked-wallet sanctions checks and fee settlement. Apply migration 0029 before deploying this command.

## OFAC list: by hand, once a month

Download https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML (about 30 MB, it ends with `</sdnList>`), then `operator addresses ofac=<path to SDN.XML> --production`. It refuses a cut file and prints the number of addresses loaded. `operator list --production` warns from 35 days after a load, and while it warns the desk sends no order. Loads: 2026-11-17 (127 addresses, OFAC publication of 2026-11-13). Next: by 2026-12-17.

## A new client

1. `operator invite --production`: give the client the code and https://pro.ophis.fi/apply.
2. The client applies (Ophis gets a Telegram message once it is submitted for review): the company (legal name, type, country of incorporation, registration number, LEI if any, registered address), the applicant (name, position, work email, phone, Telegram if any), the company domain, up to 4 more people with the same details and a role, and a passkey (on the computer, a phone or a security key). Then "Create the organisation": no DNS record (owner, 2026-11-18), so confirm the applicant and the domain with the company before approving.
3. The client signs in: a wallet (a personal wallet also works when the application names other people; it signs "Activate this organisation ..." on the signing page), the declaration (printed, signed, scanned, sealed in the browser, uploaded), "Submit for review". The operator list says whether that wallet can become the recovery wallet. Approval links an ineligible personal wallet without recovery authority; the client sets up a suitable recovery wallet afterwards. Existing proofs and sealed scans remain usable.
4. The operator: `operator list --production` (compare the domain, the passkey hash, the wallet, the declaration's SHA-256, and each person the application names: on the signed declaration with the same role, an address at the company's domain; the approval approves them all, there is no approval per person), the sanctions screening (README, "Screening, step by step"). Compare the signed recovery designation with the list: an older declaration naming an ineligible wallet is usable for verification only; if it says "None configured" but the list would grant recovery authority, obtain a corrected signed declaration before approval. Then `operator decide <id> approve --submission <16 characters> --tier standard --source registry --evidence "<reference>" --sha256 <64 hex> --next-review <date> --screening clear --list eu=<file> --production`.
5. The organisation is active. Its Owner invites the members from the console. Ophis sends no email.

A partner: its linked wallet must be the fee recipient of its integration. A Safe also needs its address and chain in the rebate indexer's `CONTRACT_WALLET_AUTH_CHAINS` (README, "Partner figures").

## The sealing key

Generation g1, made 2026-11-16, fingerprint `9d1f8c22a7c3b24f89a3b191733196d2c2509ddec5357c83bbcbaa0ce3e15b8f`, kept on two papers. Its public half is `SEAL_RECIPIENT` in `wrangler.jsonc` and `PRODUCTION` in `src/app/onboarding.tsx` (a test compares them). Opening a sealed item: README, "Sealed declaration", step 4.
