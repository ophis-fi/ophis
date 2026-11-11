# Ophis Business console: architecture

Local only. Milestones 1 (sign-in core) and 2 (enrolment and recovery ceremony for members, step-up) are built. Milestones 3 to 6 are designed here so that they need no schema rework.
Design sources: `security-design.md`, `recovery.md`, `key-custody.md` (owner research folder). The login identifies people. It never signs a trade.

## Modules
```
index.html              page shell; the Lucide icon symbols are inlined at the top of the body
public/_headers         security headers and the strict policy for the static pages
migrations/0001_init.sql  the full D1 schema (authoritative; summary below)
src/server/index.ts     Worker entry: request checks, route table and its two gates, handlers, API headers, session limits
src/server/data.ts      the ONE data module: every SQL statement, the audit chain, tickets, activation, stop, alerts
src/server/passkeys.ts  per-environment constants, stateless challenges, the two WebAuthn verifications, the three-word phrase
src/server/words.ts     data file: EFF short word list 2.0 (1,296 words, CC BY 4.0, attribution in its header)
src/app/main.tsx        React shell: band, bar, rail, footer line, routes in the URL fragment, alerts before the page
src/app/pages.tsx       sign-in, replaced-passkey page, enrolment, Organisation (invite, re-enrol, waiting list, passkeys), Security and data
src/app/ui.tsx          API call, passkey check, step-up retry, icons, badges; kit.css is the brand kit unchanged, app.css the mockup's app layer
scripts/dev.mjs         local seed and activate commands (local D1 only)
tests/worker.test.ts    invariants, in the Workers runtime with a local D1; tests/authenticator.ts is a software passkey
tests/e2e.mjs           the same flows in headless Chrome: three browser contexts, each with its own virtual authenticator
```
Static pages never run the Worker (`run_worker_first: ["/api/*"]`). Dependencies: `@simplewebauthn/server`, `react`, `react-dom`.

## Configuration
- `ENVIRONMENT` (wrangler var) selects a constant pair in `passkeys.ts`: relying-party id and origin. Neither is ever read from a request.
  Today only `local` exists: `localhost`, `http://localhost:8787`. An unknown value fails every API call with 500.
- A production entry is added once the hostname is chosen. The relying-party id is the full hostname, and it is final: passkeys are tied to it.
- `CHALLENGE_KEY` (secret, `.dev.vars`): HMAC key of the stateless challenges, 32 characters or more. Nothing else is secret.
- D1 binding `DB`. The real database must be created with `--jurisdiction=eu`. The id in `wrangler.jsonc` is a placeholder.

## D1 schema (all of the first step)
Rules: every tenant row has `org_id`; children reference parents by `(org_id, id)`; ids are 128-bit random; a bearer secret is stored as SHA-256 only; times are Unix ms; tables are `STRICT`.

| Table | Columns | Notes |
|---|---|---|
| organisations | id, kind (partner, institution), name, state (unverified, active, frozen, archived), email_domain, domain_challenge, domain_verified_at, synced_keys_allowed, quarantine_until, created_at | Company domain proved by DNS (M5). |
| seats | id, org_id, display_name, email, role (owner, admin, trader, approver, compliance, viewer), state (invited, active, frozen, removed), quarantine_until, created_at | One person in one organisation. Email is optional and never a key. |
| enrolment_tickets | id, org_id, seat_id, kind (first_owner, invitation, re_enrolment), role, issuer_seat_id, token_hash, nonce, state (issued, stored, confirmed, cancelled, dead), attempts (0 to 3), expires_at, stored_at, wait_until, created_at | Single use. The nonce feeds the three-word phrase. |
| credentials | id, org_id, seat_id, public_key, counter, device_bound, transports, label, state (pending, active, suspended, revoked), spare, ticket_id (unique), stop_right_until, created_at, last_used_at | Public material only. One credential per ticket. |
| sessions | id, token_hash, challenge_hash (unique), org_id, seat_id, credential_id, created_at, last_seen_at, step_up_at, revoked_at, user_agent, country, asn | No IP address. A used sign-in challenge is recorded here. |
| approvals | id, org_id, action, subject_id, payload, payload_hash, requester_seat_id, checker_seat_id, state, not_before, expires_at, created_at, decided_at | `CHECK`: the checker is never the requester. |
| wallets | id, org_id, chain_id, address, kind (safe, custodian, single_key), label, state, proof_nonce (unique), proof_digest, proof_signature, proof_checked_at, linked_at, anchor (current, next), anchor_effective_at | Unique index on `(org_id, anchor)`: one recovery anchor in force, at most one waiting 72 h to replace it. |
| recovery_requests | id, org_id, wallet_id, seat_id, action, credential_hash, nonce (unique), digest, signature, owners_snapshot, state (waiting, cancelled, ready, completed, lapsed), wait_until, objected, created_at, closed_at | Last-Owner recovery. One open request per organisation. |
| kyb_records | id, org_id, legal_name, registration_number, country, tier, source, evidence_ref, evidence_sha256, signer_cert_sha256, screening_outcome, screening_lists, screening_list_version_hash, screened_at, decision, decided_at, recheck_at, created_at | The result, never the documents. One row per review. |
| sealed_items | id, org_id, kind (kyb_pack, declaration, screening_detail), key_generation, ciphertext (2 MB cap), sha256, uploaded_by_seat_id, kyb_record_id, created_at | Sealed in the browser (age v1). No key at the server. |
| audit_log | org_id, seq, at, actor_kind, actor_id, session_id, action, subject_id, detail, country, asn, prev_hash, hash | Ids only. Primary key `(org_id, seq)`. Triggers refuse UPDATE and DELETE. |

Audit chain: `hash = SHA-256(JSON([org_id, seq, at, actor_kind, actor_id, session_id, action, subject_id, detail, country, asn, prev_hash]))`; the first `prev_hash` is 64 zeros.
Every state change goes through `commit()` in `data.ts`: the change and its audit row are one `db.batch()`, one transaction.
`commit()` reads the head, then runs the caller's plan, then writes with the next sequence number. Any other write of the organisation in between takes that number and the batch fails, so what a plan read is still true when it commits. One retry.

### The ceremony as built (M2; `recovery.md` sections 1 and 2)
- Ticket: 256-bit token, only in the link fragment and in one response; SHA-256 stored. 10 min for key roles, 24 h for Trader and Viewer. 3 per issuer and seat per 24 h. Issuer: Owner or Admin, never above the own role, never the own seat. The seat decides the kind: `invited` gives an invitation, `active` a re-enrolment.
- Phrase: `words3(SHA-256("ophis-enrol-v1" ‖ site ‖ org ‖ seat ‖ role ‖ purpose ‖ credentialHash ‖ nonce))`, every field with a 4-byte length; site is the relying-party id, purpose the ticket kind, the nonce 128 server bits that never leave the server. Never stored. Returned once, by `enrol/finish`, to the member's device.
- Confirmation: the issuer types the words within 60 min, in a request that carries its own passkey check (challenge bound to ticket id, credential hash and try number). 3 wrong tries kill the ticket and the pending passkey. Words that are not on the list are a typing slip, not a try.
- Key roles: the issuer's words write an `approvals` row (`ticket.confirm`, requester = issuer). A second key-role member (not issuer, not target) types the words within the same 60 min and becomes its checker. If no such active seat exists: `not_before` = 72 h, and the pending passkey becomes active at its first sign-in in the 7 days after. No scheduled job.
- Activation: new passkey `active`; on a re-enrolment the seat's active passkeys become `suspended` with `stop_right_until`, and the seat gets `quarantine_until` (24 h Trader and Viewer, 72 h key roles); the seat's sessions end; its other open tickets die.
- Stop: a suspended passkey with a running stop right opens no session. `signin/finish` tells it so (403 `passkey_replaced`) once its check passed; `stop/finish` then revokes the seat's active passkeys, restores the suspended ones, freezes the seat. Unfreezing needs two people: milestone 3.
- A sign-in with a passkey the member still holds kills every open ticket of that seat (audit detail `ticket_killed`): this is how the target cancels during the wait.
- Alerts are computed at `GET /api/me` from rows of the last 7 days (no table, no email): quarantine, new passkey on the seat, re-enrolment started or completed, a colleague re-enrolled, a frozen seat, words waiting for this member. The app shows them before the page; the browser remembers what was read.

### Wallets and the recovery anchor (M4): typed data and contract wallets
- A proof is EIP-712 typed data (`recovery.md` section 5). Domain: name `Ophis Business`, version `1`, `chainId` of the wallet's pinned chain. There is no `verifyingContract`: no contract verifies it. The binding to this app is inside the message: `site`, `organisationId`, `wallet`.
- Replay protection is in the message and in D1: a `bytes32` nonce accepted once (`proof_nonce`, `recovery_requests.nonce` are unique), `issuedAt`, `expiresAt`, and an `action` that is one of four fixed sentences.
- The server rebuilds the typed data and the digest from its own fields, never from client text, and stores that digest.
- Single key: recover the signer; it must equal the wallet. Refuse a high-s or malformed signature. Try recovery first and ERC-1271 second; do not classify by code size, because an EOA with an EIP-7702 delegation has code.
- Contract wallet: `isValidSignature(bytes32,bytes)` on the pinned chain must return `0x1626ba7e`, from two independent RPC endpoints that agree. An onchain Safe message arrives with signature `0x`. Check again at every use: owners and modules change. A Safe with a module is amber, not green.
- Addresses are stored lower-case with their chain id; EIP-55 case is for display. No contract address is typed from memory: any Safe singleton allow-list is verified onchain before it enters the code.

## Routes
Every `/api/*` call: `Sec-Fetch-Site: same-origin` or 403. Every state change: POST, JSON, `Origin` equal to the configured origin, body under 64 KB. No CORS grant.
Two gates in the route table (M2). `twoKeys`: the seat holds two active passkeys, device-bound ones for an Owner; with fewer it can sign in, pass a check and add its second key. `fresh`: a passkey check in the last 5 minutes ("Step-up: yes").

| M | Route | Authentication | Roles | Step-up | Second person |
|---|---|---|---|---|---|
| 1 | POST /api/enrol/start | ticket token in the body | the ticket's seat | no | no |
| 1 | POST /api/enrol/finish | ticket token and a new passkey with user verification | the ticket's seat; Owner must be device-bound | no | result is pending; answers the three words (M2). First Owner: the dev command confirms |
| 1 | POST /api/signin/start | none; writes nothing | any | no | no |
| 1 | POST /api/signin/finish | active passkey with user verification | any active seat | no | no |
| 1 | GET /api/me | session | any; M2 adds the alerts | no | no |
| 1 | GET /api/org | session | Owner, Admin: the organisation and every open ticket; others: own seat, and tickets waiting for their words | no | no |
| 1 | POST /api/sessions/:id/revoke | session | own session: any; a colleague's: Owner, Admin | no | no |
| 1 | POST /api/signout | session | any | no | no |
| 2 | POST /api/stepup/start, /finish | session and an active passkey of the own seat | any | it is the step-up: 5 min window, new session token | no |
| 2 | POST /api/passkeys/start, /finish | session | own seat; the new passkey is active at once; other sessions of the seat end | yes | no |
| 2 | POST /api/passkeys/:id/revoke | session, two passkeys | own active passkey (never the last); a colleague's: Owner, Admin, not above own role, not in quarantine, seat not frozen | yes | no |
| 2 | POST /api/tickets | session, two passkeys | Owner, Admin; rules above; an invitation is blocked in quarantine | yes | no |
| 2 | POST /api/tickets/:id/confirm/start, /confirm | session, two passkeys; three words typed | the issuer, then another key-role member for key roles; an invitation is blocked in quarantine | own passkey check, bound to the ticket | key roles: yes, or the 72 h wait |
| 2 | POST /api/tickets/:id/cancel | session, two passkeys | Owner | yes | no |
| 2 | POST /api/stop/start, /finish | check of a suspended passkey; no session | the replaced passkey, until its stop right ends | passkey check | no |
| 3 | GET /api/approvals; POST /api/approvals/:id/approve, /reject | session | key roles; never the requester | yes | this is the second person |
| 3 | POST /api/members/:id/role, /remove | session | Owner, Admin; never the last Owner | yes | yes |
| 3 | GET /api/audit, /api/audit/export | session | Owner, Viewer, Compliance officer | export: yes | no |
| 4 | POST /api/wallets/link/start, /finish; /api/wallets/:id/unlink | session and a wallet signature | Owner, Admin | yes | link: yes |
| 4 | POST /api/anchor | session | Owner | yes | yes; counts after 72 h |
| 4 | POST /recover/intent, /recover/proof | no cookie; anchor signature; proof-page origin only | the anchor's signers | no | 72 h wait, cancel and veto |
| 5 | POST /api/apply | none, Turnstile first; company email domain, DNS record | applicant | no | operator KYB decision |
| 5 | POST /api/kyb/sealed; GET /api/kyb | session | Owner, Compliance officer | yes | no |
| 5 | operator console, own hostname | Cloudflare Access token, checked on every request | Ops, Compliance | hardware key | none: one operator today |
| 6 | POST /api/support/ask | session | any | no | no |

## Security invariants and the tests that prove them
Each test (in `tests/worker.test.ts`) was seen to fail with its control removed once. Milestone 1, independent review, 2026-11-11: 71 single mutations, 70 caught; the survivor was the purpose label inside the challenge HMAC, which milestone 2 now tests.
Milestone 2, 2026-11-11: 110 single mutations of its controls, all caught, and four more against `tests/e2e.mjs`. Not separately provable, because another check covers the same case: the ticket id inside the confirmation binding (the credential hash is already unique per ticket), and the early stop-right check a handler could add (the write checks it).

| Invariant | Test |
|---|---|
| A passkey answers only for the configured origin and relying-party id, with user verification | a: `rejects an assertion made for another origin`, `...another relying-party id`, `...without user verification`, `rejects a registration made for another origin...`; d: `the expected origin is the configured one...` |
| A challenge is ours, fresh (5 min), bound to its ticket, and opens one session | a: `rejects a challenge after 5 minutes`, `rejects a challenge it did not issue`, `opens one session per assertion: a replay is refused`; e: `POST /api/enrol/finish` |
| Expiry (challenge, ticket, session) is judged once the request body has arrived | a: `judges expiry when the body has arrived...` |
| A signature counter that goes backwards is refused, and the stored counter never goes down | a: `refuses a passkey whose counter goes backwards...` |
| Only an active passkey of an active seat in an active organisation signs in | b: `a pending credential cannot sign in`, `a suspended or revoked credential cannot sign in, and its session ends`, `a frozen seat or a frozen organisation cannot sign in` |
| Owners enrol device-bound keys only, whatever the organisation allows; other key roles unless it allows synced keys. A ticket whose role is not its seat's role is dead | b: `an Owner cannot enrol a synced passkey; a Viewer can`, `the seat decides the key rule...` |
| A ticket works once, for 10 minutes, for a live seat in a live organisation; the key label is short plain text | b: `a ticket stores one credential, once`, `a key-role ticket is dead after 10 minutes...`, `a ticket is dead once its seat is removed...`, `a key label is short plain text` |
| Activation by command is local only | b: `activation by command refuses anything but the local database` |
| Cookie: `__Host-`, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain; only the token's hash is stored | c: `the cookie carries every required attribute and the database holds only its hash` |
| Revoke, sign-out, 15 min idle and 12 h absolute are enforced by the server | c: `a revoked session fails on the next request`, `sign-out ends the session...`, `a session ends after 15 minutes idle`, `a session ends 12 hours after sign-in...` |
| Fetch-metadata, Origin, JSON POST, body cap, no CORS | d: `refuses an API call with Sec-Fetch-Site ...` (4, every route of the table), `refuses a state change with Origin ...` (5, every POST route), `a state change is a JSON POST...`, `refuses a body over the size cap`, `grants no CORS access...` |
| No organisation sees another, on every route; a route without an isolation case fails the suite | e: `every route has an isolation case` and one test per route; `SQL lives in the data module only...`; `inside an organisation, a Viewer sees only its own seat...` |
| A state change and its audit row are one batch; rows hold ids only; the chain detects a rewrite | f: `each state change writes one row...`, `<action>: the change and its audit row succeed or fail together` (6), `rows hold ids only`, `a changed row, a removed row and a forged tail are detected` |
| Pages and API responses carry the headers and the policy | g: `every API response carries them...`, `pages carry them: public/_headers...`; e2e checks the live page and counts zero violations |
| Sign-in start writes no row; a failed sign-in says nothing | h: `writes no row, however often it is called...`, `a failed sign-in looks the same whatever the reason...` |
| The schema refuses cross-organisation rows, self-approval, a second anchor, a forked audit sequence | i: four tests |
| Two writes that collide on the audit sequence: the later one is retried once, and a plan never commits on stale reads | f: `two writes of one organisation that collide...`; k, n, o: the three `...at the same instant` tests |
| A challenge serves one purpose: sign-in, enrol, step-up, add, confirm, stop | j: `a challenge made for one purpose does not pass for another...`; k: `a step-up answers only a step-up challenge...`; o: `a stop answers only a stop challenge...` |
| The phrase is derived as specified, changes with every input, from the 1,296-word list | j: three tests (the recipe is written out in the test) |
| Step-up: 5 minutes, a new token, once, by an active passkey of the own seat | k: `a sensitive call more than 5 minutes...`, `step-up gives the session a new token...`, `a step-up answers only...`, `the routes that need a fresh check...` |
| A seat with fewer than two passkeys (device-bound for an Owner) does nothing sensitive but add its second | k: `an Owner seat with fewer than two device-bound keys...`, `every seat needs two active passkeys...` |
| Own passkeys: fresh check, session-bound challenge, key rule of the role, cap of 10, other sessions end; revoke rules | l: four tests |
| Tickets: who issues for whom, token hashed, lifetimes, 3 per issuer and seat, Owner cancels, dead with its seat | m: seven tests; n: `a ticket is dead once its seat is not in the right state` |
| The issuer's API never returns the phrase or the nonce; only the issuer confirms, with a check bound to the ticket | n: `a Viewer joins...`, `only the issuer confirms...` |
| 3 wrong tries kill ticket and passkey, exact counter, one try per passkey check; 60 minutes | n: `three wrong tries kill the ticket...`, `the words must be typed within 60 minutes...` |
| Key roles: a second person, not issuer, not target, a key role; else 72 h, cancellable by an Owner or the target's old passkey | n: `a key role needs a second person...`, `with no second person, a 72 hour wait...`, `during the wait any Owner can cancel...` |
| Re-enrolment suspends, never deletes; a suspended passkey can only stop, until quarantine ends; quarantine blocks | o: seven tests |
| Alerts reach the member, the confirmers and every member, and no other organisation | p: two tests |

## Deliberate shortcuts (`ponytail:` in the code)
- The idle clock is written at most once a minute: a session can end up to 60 s early, never late.
- Writes of one organisation are serialised by the audit sequence, with one retry. Many writers at the same instant would need a queue.
- `verifyAudit` reads a whole chain. A removed tail is only detectable with the external hourly anchor, which is not built.
- `scripts/dev.mjs activate` stands in for the first Owner's activation by the recovery anchor (M4). Members no longer need it.
- Alerts are read from rows of the last 7 days; the server keeps no "seen" mark. Expired tickets stay in the table: nothing sweeps.
- After two re-enrolments inside one quarantine a stop restores the passkeys of both earlier rounds. The freeze makes that safe until M3 decides.
- The link is shown as text with a copy button: no QR code (it would need a dependency).
- Not built yet: unfreezing a seat (M3), rate limits, Turnstile, a passkey check on a change of country or network, the spare key, linked Google or Microsoft identity, the production hostname.

## Commands
`npx -y pnpm@10.34.9 install --ignore-workspace`, then `pnpm migrate`, `pnpm seed`, `pnpm dev`, `pnpm activate`, `pnpm test`, `pnpm test:e2e`, `pnpm typecheck` (see README.md).

## Milestones
- M1 sign-in core: passkey enrolment (pending), sign-in, sessions, request checks, audit chain, console shell. Built.
- M2 enrolment and recovery ceremony: tickets, three-word phrase, confirmations, step-up, second key, stop right, quarantine, alerts at sign-in. Built (paths A and B; path C is M4).
- M3 roles and two-person approval: approvals, member and role changes, audit view and export.
- M4 wallets and recovery anchor: wallet link, anchor, EIP-712 proof, ERC-1271, last-Owner recovery.
- M5 registration, KYB and sealing: application, DNS domain proof, sealed uploads, operator console.
- M6 support: assistant, hand-over by a mailto link to the operator's mailbox. The label is "Support".
