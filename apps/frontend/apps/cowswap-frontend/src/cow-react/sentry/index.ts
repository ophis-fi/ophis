import { environmentName, registerOnWindow } from '@cowprotocol/common-utils'

import * as Sentry from '@sentry/react'

import { SENTRY_IGNORED_QUOTE_ERRORS } from 'api/cowProtocol/errors/QuoteError'
import { USER_SWAP_REJECTED_ERROR } from 'common/utils/getSwapErrorMessage'

import { beforeSend } from './beforeSend'
import { NO_DEDUP_EVENTS } from './events'

import pkg from '../../../package.json'

// Sentry v8 (2026-05-21): `@sentry/types` was deprecated and rolled into
// `@sentry/core`. `Event`/`EventHint`/`Breadcrumb` re-export through
// `@sentry/react`; `Integration` is NOT re-exported (lives at
// `@sentry/core/types-hoist`). We avoid needing the `Integration` type
// here by returning the inferred shape of `Sentry.dedupeIntegration()` —
// TypeScript structurally validates the result against the integration
// API surface where it's used as a `defaultIntegrations[]` element.
// Sharp-edges audit (PR #197 follow-up) flagged the v7→v8 import surface
// as a runtime-init blocker if missed.
import type { Event, EventHint } from '@sentry/react'

const SENTRY_DSN = process.env.REACT_APP_SENTRY_DSN
const SENTRY_TRACES_SAMPLE_RATE = process.env.REACT_APP_SENTRY_TRACES_SAMPLE_RATE
const GIT_COMMIT_HASH = process.env.REACT_APP_GIT_COMMIT_HASH
const GIT_COMMIT_DATE = process.env.REACT_APP_GIT_COMMIT_DATE

/**
 * Dedupe wrapper that skips deduplication for events whose message
 * appears in NO_DEDUP_EVENTS.
 *
 * v7.85 migration:
 *   - Pre-7.85 this was `class SentryDedupeLocal extends Sentry.Dedupe`.
 *     The v7.85+ release moved `Sentry.Dedupe.processEvent` from a
 *     method to a property, breaking the subclass-override pattern.
 *   - We now wrap the FUNCTIONAL `Sentry.dedupeIntegration()`
 *     (re-exported from `@sentry/integrations`), preserving the
 *     skip-list behavior.
 *
 * The skip-list check covers BOTH `event.message` (captureMessage
 * events) AND `event.exception.values[0].value` (captureException
 * events). The original class-based code only looked at `event.message`
 * — sharp-edges audit Finding 6 (2026-05-21) flagged this as a
 * dedupe-skip miss for exception-typed events. Fixed here.
 */
// v8: return-type intentionally inferred from `Sentry.dedupeIntegration()`
// shape — see import-block comment above. `client` is typed `unknown`
// because we don't introspect it; v8's Integration.processEvent signature
// has `client: Client` from @sentry/core, but `unknown` satisfies
// contravariant param position.
function dedupeWithExceptionsIntegration() {
  const base = Sentry.dedupeIntegration()
  return {
    ...base,
    name: 'DedupeWithExceptions',
    processEvent(event: Event, hint: EventHint, client: unknown) {
      const exceptionMessage = event.exception?.values?.[0]?.value
      const skip =
        (event.message && NO_DEDUP_EVENTS.includes(event.message)) ||
        (exceptionMessage && NO_DEDUP_EVENTS.includes(exceptionMessage))
      if (skip) {
        return event
      }
      // Preserve `null` returns — base.processEvent returns null when it
      // decides to drop a duplicate event. Using `?? event` here would
      // silently convert that null to the event, defeating dedup.
      return base.processEvent ? base.processEvent(event, hint, client as never) : event
    },
  }
}

const release = 'Ophis@v' + pkg.version
registerOnWindow({
  release,
  gitCommitHash: GIT_COMMIT_HASH,
  gitCommitDate: GIT_COMMIT_DATE,
})

if (SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN,
    /**
     * @sentry/browser@8.x (2026-05-21 migration from v7.119+):
     *   - All 7 built-in browser integrations are now functional
     *     factories (`xxxIntegration()`), no longer
     *     `new Sentry.Integrations.X()` classes.
     *   - `Sentry.Integrations.TryCatch` was RENAMED to
     *     `browserApiErrorsIntegration` in v8 — keep an eye on this on
     *     future bumps.
     *   - `defaultIntegrations: [...]` still accepts a custom array;
     *     omitting an integration removes it from the default set.
     *   - The custom `dedupeWithExceptionsIntegration()` wrapper still
     *     wraps `Sentry.dedupeIntegration()` — same functional API
     *     surface across v7→v8 for that one specifically.
     */
    defaultIntegrations: [
      Sentry.inboundFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.browserApiErrorsIntegration(),
      Sentry.breadcrumbsIntegration(),
      Sentry.globalHandlersIntegration(),
      Sentry.linkedErrorsIntegration(),
      dedupeWithExceptionsIntegration(),
      Sentry.httpContextIntegration(),
      Sentry.browserTracingIntegration(),
    ],
    release,
    environment: environmentName,
    ignoreErrors: [...SENTRY_IGNORED_QUOTE_ERRORS, `Can't find variable: bytecode`, USER_SWAP_REJECTED_ERROR],
    beforeSend,
    // Set tracesSampleRate to 1.0 to capture 100%
    // of transactions for performance monitoring.
    // We recommend adjusting this value in production
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE ? Number(SENTRY_TRACES_SAMPLE_RATE) : 1.0,
  })
}
