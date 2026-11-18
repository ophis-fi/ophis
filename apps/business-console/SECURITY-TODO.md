# Business console: security, in place and to do (internal)

Internal to-do list, not shown to clients. It was the public "Security and data" page of the console until 2026-11-17 (owner: "this list should be for ourselves for the to do list"). "In place" means in place for the product that runs now; every row about the console said "Planned" until the console shipped. Update a row when it ships.

**First to do:** the console went live on 2026-11-17, so most rows below that say to do are probably done now. Review each one against the code and tick it.

2 of 22 in place, 20 to do.

## How you sign in

Passkeys first.

- [ ] **Passkey sign-in**: Sign-in uses passkeys, with no passwords and no SMS codes.
- [ ] **Stricter rule for key roles**: Owners, admins, approvers and compliance officers sign in with passkeys only, with no fallback code.
- [ ] **Short sessions**: A session locks after 15 minutes idle and ends after 12 hours.

## If you lose access

No weak reset.

- [ ] **No reset by email, phone or code**: No email, phone call or typed code can reset access to an account.
- [ ] **Colleagues confirm a new passkey**: A lost passkey is replaced only after a colleague confirmed the new passkey with a passkey of their own. The console asks them to check with the member first, by a channel both trust. Key roles need two colleagues.
- [ ] **Your wallet is the last resort**: If every Owner is locked out, only the recovery wallet of your organisation can restore access, after a 72-hour wait.
- [ ] **Time to object**: For some days after a recovery the replaced passkey can still stop the new one, and sensitive changes are blocked.

## What we store

Results and records.

- [ ] **Stored in the EU**: The account database is restricted to the European Union and encrypted at rest.
- [ ] **No decryption key in the cloud**: Our servers and our cloud provider hold no key that can open sealed records.
- [ ] **Sealed in your browser**: Owner names, signatories, contact persons and signed declarations are encrypted in your browser before upload. One offline key opens them, kept on paper in two places. The key fingerprint is printed in your contract.
- [ ] **Readable by design**: Member names, roles, linked wallets and company details are stored readable, because the service uses them on every request.
- [ ] **Results, not documents**: We keep a verification result and a fingerprint of the evidence, not copies of identity documents.
- [ ] **Tamper-evident audit log**: Every action, including ours, is written to a hash-chained log that you can export.
- [ ] **Backups**: The account database can be restored to any minute of the last 7 days. A weekly copy, sealed with the same offline key, is kept outside the cloud provider.

## Who can read it

Your organisation first.

- [ ] **Your data, kept apart**: Every record belongs to one organisation, and each endpoint is tested against access from another.
- [ ] **No impersonation**: Ophis has no feature to sign in as you, and each access through our console appears in your log.
- [ ] **Two-person approval**: Changes to wallets, payout addresses, members, API keys and security settings need a second person.
- [ ] **Support assistant**: The assistant receives your question with emails, addresses and your organisation name removed, plus public help articles. An outside provider runs it in the United States. Ophis does not store the question text.

## How we build it

Checks on every change.

- [x] **Checked code**: Every pull request is scanned for known vulnerabilities and leaked secrets. New dependency versions wait 7 days, except reviewed security fixes.

## What we never hold

Your keys and your documents.

- [x] **Your keys stay with you**: Ophis never holds your private keys. Every trade is signed by your own wallet or custodian.
- [ ] **Check before you sign**: Each order is shown decoded, with tokens, amounts, receiver and fees, before your wallet signs.
- [ ] **No passwords, no documents**: The account system stores no passwords, no seed phrases, no SMS numbers for sign-in, no identity documents and no card or bank details.

## Limits

No hardware security module, no external certification of Ophis, one operator today. Only the database is pinned to the EU.

