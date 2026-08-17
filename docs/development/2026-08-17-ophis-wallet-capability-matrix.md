# Ophis wallet capability matrix

**Status:** Milestone B, local-only implementation

**Publication:** Not pushed, deployed, or released

**Scope:** Existing injected-provider discovery and optional wallet call batching

## Outcome

Ophis now uses one exported, fail-closed capability model for the primary frontend. Capability data is scoped to the active chain, malformed data never enables batching, and an injected wallet re-announcement refreshes the live provider object instead of retaining stale state.

Batching remains an optional wallet interaction optimization. It does not make separately settled orders atomic, and a rejected or uncertain batch is never replayed automatically.

Ophis Lite remains deliberately wallet-free in its current deterministic prototype. It should consume this model only if a later approved milestone adds wallet interaction; duplicating capability rules inside the static prototype is not justified now.

## Injected-provider discovery matrix

| Situation                                            | Ophis behavior                                                                                             | Evidence                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Server-side import                                   | Does not touch `window`; discovery state starts empty                                                      | `multiInjectedProvidersAtom.ts` browser guard |
| Initial page load                                    | Listener is registered before the provider request event is dispatched                                     | `multiInjectedProvidersAtom.ts`               |
| Late provider announcement                           | Valid provider is prepended without removing other wallet brands                                           | `upsertEip6963Provider` test                  |
| Repeated identical announcement                      | Existing array identity is retained; no state churn                                                        | `upsertEip6963Provider` test                  |
| Same wallet brand re-announces a new provider object | Old entry is replaced by UUID/RDNS identity and the new object becomes selectable                          | `upsertEip6963Provider` test                  |
| Malformed event detail                               | Ignored without throwing or mutating state                                                                 | `isEip6963ProviderDetail` test                |
| Remembered RDNS differs only by case                 | Resolves to the announced provider                                                                         | `findEip6963ProviderByRdns` test              |
| Remembered value is malformed or provider is absent  | Resolves to no selected provider                                                                           | `findEip6963ProviderByRdns` test              |
| Embedded widget mode                                 | Existing eager-connect flow ignores the remembered injected provider                                       | `useEagerlyConnect.ts`                        |
| Iframe metadata lookup                               | Existing bridge associates metadata by provider object identity; it does not choose the connected provider | `IframeRpcProviderBridge.ts` and `utils.ts`   |

There is no standardized provider-removal event in this discovery protocol. Ophis can refresh a re-announced provider and fail closed when a remembered provider is absent, but it cannot reliably infer that an extension was removed without a page lifecycle change or a wallet-originated disconnect.

## Wallet call capability matrix

| Capability or failure state                                     | Ophis behavior                                                                       | Automatic replay? |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------- |
| `supported` or `ready` on the active chain                      | Optional batch tier may be offered                                                   | No                |
| `unsupported`, missing, or malformed status                     | Use stepped interaction                                                              | No                |
| Response contains only another chain                            | Ignore it; use stepped interaction                                                   | No                |
| Response contains ambiguous duplicate keys for the active chain | Ignore it; use stepped interaction                                                   | No                |
| Capability request times out or method is unavailable           | Treat as unknown/unsupported                                                         | No                |
| Mobile WalletConnect capability request                         | Existing guard avoids the request because some wallets turn it into repeated prompts | No                |
| Account, chain, or wallet client changes                        | Reset cached capability and invalidate in-flight detection                           | No                |
| Older `atomicBatch.supported` response                          | Normalize to the shared supported state                                              | No                |
| Wallet exposes no send-calls method after advertising support   | Disable the optional batch tier and surface the failure                              | No                |
| User or wallet rejects the batch                                | Disable the optional batch tier and surface the failure                              | No                |
| Wallet returns an empty/malformed batch ID                      | Treat submission as uncertain, disable batching, and surface the failure             | No                |
| Capability detection resolves after the chain changes           | Ignore the stale result                                                              | No                |

An error after a wallet submission request can be ambiguous: transport failure does not prove that no call was accepted. The only safe fallback is a new, explicit user action after status reconciliation. Ophis must not silently resend those calls one by one.

## User-facing state machine

1. **Disconnected:** show Connect Wallet.
2. **Wrong network:** show Switch Network before any approval or signing action.
3. **Allowance already sufficient:** do not request another approval.
4. **Allowance required:** show an explicit, bounded VaultRelayer approval and wait for confirmation.
5. **Intent signing:** use the normal EIP-712 order-signature path.
6. **Optional supported batch tier:** batch only the supported pre-sign calls after an active-chain capability check.
7. **Batch failure or uncertainty:** stop, show a human-readable error, reconcile status, then allow a separately initiated stepped path.

User-facing copy must say “one wallet interaction” or “same-batch submission,” never “atomic settlement.” Each order retains its own settlement, status, and cancellation behavior.

## Privacy-preserving telemetry design

A future telemetry event may contain:

- surface: primary frontend or approved Ophis Lite version;
- numeric chain ID;
- discovery outcome: supported, unsupported, timeout, malformed, or stale;
- selected path: stepped or batched;
- batch outcome: accepted ID, rejected, malformed response, or unknown;
- coarse latency bucket;
- fallback reason from a fixed enum.

It must not contain wallet addresses, provider UUIDs, RDNS values, wallet names, raw provider errors, calldata, signatures, order UIDs, or token amounts.

## Verification added

- Ten wallet-library tests cover exact-chain selection, malformed responses, ambiguous chain keys, legacy/current capability shapes, batch-ID validation, late announcements, provider replacement, idempotent repeats, and malformed remembered state.
- Eleven primary-frontend tests cover pure capability/call assembly plus hook-level confirmation, rejection, missing method, malformed ID, no automatic replay, and stale chain-switch completion.
- File-level ESLint and Prettier checks cover every changed TypeScript file.
- The primary frontend TypeScript target passes.

## Residual work

1. Add calls-status reconciliation before presenting a stepped retry after an uncertain submission.
2. Wire the optional batch hook into a complete user-facing flow only after copy and status UX are reviewed.
3. Add anonymized telemetry only after the event schema receives privacy review.
4. Migrate the legacy capability fetch from SWR when the dual wallet-stack migration removes its widget/provider compatibility constraint.
5. Keep Ophis Lite wallet-free until a separately approved version requires signing or submission.
