# Ophis Business console: architecture

Local only. Milestone 1 (sign-in core) is built. Milestones 2 to 6 are designed here so that they need no schema rework.
Design sources: `security-design.md`, `recovery.md`, `key-custody.md` (owner research folder). The login identifies people. It never signs a trade.

## Modules
```
index.html              page shell; the Lucide icon symbols are inlined at the top of the body
public/_headers         security headers and the strict policy for the static pages
migrations/0001_init.sql  the full D1 schema (authoritative; summary below)
src/server/index.ts     Worker entry: request checks, route table, handlers, API headers, session limits
src/server/data.ts      the ONE data module: every SQL statement, the audit chain, verifyAudit
src/server/passkeys.ts  per-environment constants, stateless challenges, the two WebAuthn verifications
src/app/main.tsx        React shell: band, bar, rail, footer line, routes in the URL fragment
src/app/pages.tsx       sign-in, enrolment, Organisation, Security and data
src/app/ui.tsx          API call, icons, badges; kit.css is the brand kit unchanged, app.css the mockup's app layer
scripts/dev.mjs         local seed and activate commands (local D1 only)
tests/worker.test.ts    invariants, in the Workers runtime with a local D1; tests/authenticator.ts is a software passkey
tests/e2e.mjs           the same flow in headless Chrome with a virtual authenticator
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

### Wallets and the recovery anchor (M4): typed data and contract wallets
- A proof is EIP-712 typed data (`recovery.md` section 5). Domain: name `Ophis Business`, version `1`, `chainId` of the wallet's pinned chain. There is no `verifyingContract`: no contract verifies it. The binding to this app is inside the message: `site`, `organisationId`, `wallet`.
- Replay protection is in the message and in D1: a `bytes32` nonce accepted once (`proof_nonce`, `recovery_requests.nonce` are unique), `issuedAt`, `expiresAt`, and an `action` that is one of four fixed sentences.
- The server rebuilds the typed data and the digest from its own fields, never from client text, and stores that digest.
- Single key: recover the signer; it must equal the wallet. Refuse a high-s or malformed signature. Try recovery first and ERC-1271 second; do not classify by code size, because an EOA with an EIP-7702 delegation has code.
- Contract wallet: `isValidSignature(bytes32,bytes)` on the pinned chain must return `0x1626ba7e`, from two independent RPC endpoints that agree. An onchain Safe message arrives with signature `0x`. Check again at every use: owners and modules change. A Safe with a module is amber, not green.
- Addresses are stored lower-case with their chain id; EIP-55 case is for display. No contract address is typed from memory: any Safe singleton allow-list is verified onchain before it enters the code.

## Routes
Every `/api/*` call: `Sec-Fetch-Site: same-origin` or 403. Every state change: POST, JSON, `Origin` equal to the configured origin, body under 64 KB. No CORS grant.

| M | Route | Authentication | Roles | Step-up | Second person |
|---|---|---|---|---|---|
| 1 | POST /api/enrol/start | ticket token in the body | the ticket's seat | no | no |
| 1 | POST /api/enrol/finish | ticket token and a new passkey with user verification | the ticket's seat; Owner must be device-bound | no | result is pending; the dev command confirms (M2: colleagues) |
| 1 | POST /api/signin/start | none; writes nothing | any | no | no |
| 1 | POST /api/signin/finish | active passkey with user verification | any active seat | no | no |
| 1 | GET /api/me | session | any | no | no |
| 1 | GET /api/org | session | Owner, Admin: the organisation; others: own seat | no | no |
| 1 | POST /api/sessions/:id/revoke | session | own session: any; a colleague's: Owner, Admin | no | no |
| 1 | POST /api/signout | session | any | no | no |
| 2 | POST /api/stepup/start, /finish | session and passkey | any | it is the step-up; new session token | no |
| 2 | POST /api/tickets | session | Owner, Admin; never above own role; 3 per issuer and seat per 24 h | yes | no |
| 2 | POST /api/tickets/:id/confirm | session; three words typed | the issuer, then another key-role member for key roles | yes; challenge covers ticket and credential hash | key roles: yes, or a 72 h wait |
| 2 | POST /api/tickets/:id/cancel | session | Owner; the target's own passkey | yes | no |
| 2 | POST /api/passkeys, /api/passkeys/:id/revoke | session | own seat; Owner, Admin revoke | yes | no |
| 2 | POST /api/passkeys/:id/stop | check of a suspended passkey | the replaced passkey, until its stop right ends | passkey check | no |
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
Each test (in `tests/worker.test.ts`) was seen to fail with its control removed once: 58 single mutations, all caught.

| Invariant | Test |
|---|---|
| A passkey answers only for the configured origin and relying-party id, with user verification | a: `rejects an assertion made for another origin`, `...another relying-party id`, `...without user verification`, `rejects a registration made for another origin...`; d: `the expected origin is the configured one...` |
| A challenge is ours, fresh (5 min), bound to its ticket, and opens one session | a: `rejects a challenge after 5 minutes`, `rejects a challenge it did not issue`, `opens one session per assertion: a replay is refused`; e: `POST /api/enrol/finish` |
| Only an active passkey of an active seat in an active organisation signs in | b: `a pending credential cannot sign in`, `a suspended or revoked credential cannot sign in, and its session ends`, `a frozen seat or a frozen organisation cannot sign in` |
| Owners enrol device-bound keys only | b: `an Owner cannot enrol a synced passkey; a Viewer can` |
| A ticket works once, and for 10 minutes | b: `a ticket stores one credential, once`, `a key-role ticket is dead after 10 minutes...` |
| Activation by command is local only | b: `activation by command refuses anything but the local database` |
| Cookie: `__Host-`, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain; only the token's hash is stored | c: `the cookie carries every required attribute and the database holds only its hash` |
| Revoke, sign-out, 15 min idle and 12 h absolute are enforced by the server | c: `a revoked session fails on the next request`, `sign-out ends the session...`, `a session ends after 15 minutes idle`, `a session ends 12 hours after sign-in...` |
| Fetch-metadata, Origin, JSON POST, body cap, no CORS | d: `refuses an API call with Sec-Fetch-Site ...` (4), `refuses a state change with Origin ...` (5), `a state change is a JSON POST...`, `refuses a body over the size cap`, `grants no CORS access...` |
| No organisation sees another, on every route; a route without an isolation case fails the suite | e: `every route has an isolation case` and one test per route; `SQL lives in the data module only...`; `inside an organisation, a Viewer sees only its own seat...` |
| A state change and its audit row are one batch; rows hold ids only; the chain detects a rewrite | f: `each state change writes one row...`, `<action>: the change and its audit row succeed or fail together` (6), `rows hold ids only`, `a changed row, a removed row and a forged tail are detected` |
| Pages and API responses carry the headers and the policy | g: `every API response carries them...`, `pages carry them: public/_headers...`; e2e checks the live page and counts zero violations |
| Sign-in start writes no row; a failed sign-in says nothing | h: `writes no row, however often it is called...`, `a failed sign-in looks the same whatever the reason...` |
| The schema refuses cross-organisation rows, self-approval, a second anchor, a forked audit sequence | i: four tests |

## Deliberate shortcuts (`ponytail:` in the code)
- The idle clock is written at most once a minute: a session can end up to 60 s early, never late.
- Writes of one organisation are serialised by the audit sequence. A simultaneous write fails whole; there is no retry yet.
- `verifyAudit` reads a whole chain. A removed tail is only detectable with the external hourly anchor, which is not built.
- `scripts/dev.mjs activate` stands in for the three-word ceremony. Milestone 2 replaces it.
- Not built yet: rate limits, Turnstile, step-up, alerts, the second Owner key, the production hostname.

## Commands
`npx -y pnpm@10.34.9 install --ignore-workspace`, then `pnpm migrate`, `pnpm seed`, `pnpm dev`, `pnpm activate`, `pnpm test`, `pnpm test:e2e`, `pnpm typecheck` (see README.md).

## Milestones
- M1 sign-in core: passkey enrolment (pending), sign-in, sessions, request checks, audit chain, console shell. Built.
- M2 enrolment and recovery ceremony: tickets, three-word phrase, confirmations, step-up, second key, stop right, quarantine.
- M3 roles and two-person approval: approvals, member and role changes, audit view and export.
- M4 wallets and recovery anchor: wallet link, anchor, EIP-712 proof, ERC-1271, last-Owner recovery.
- M5 registration, KYB and sealing: application, DNS domain proof, sealed uploads, operator console.
- M6 support: assistant, hand-over by a mailto link to the operator's mailbox. The label is "Support".
