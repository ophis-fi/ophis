import { environmentName, registerOnWindow } from '@cowprotocol/common-utils'

import * as Sentry from '@sentry/react'

import { SENTRY_IGNORED_QUOTE_ERRORS } from 'api/cowProtocol/errors/QuoteError'
import { USER_SWAP_REJECTED_ERROR } from 'common/utils/getSwapErrorMessage'

import { beforeSend } from './beforeSend'
import { NO_DEDUP_EVENTS } from './events'

import pkg from '../../../package.json'

import type { Event, EventHint, Integration } from '@sentry/types'

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
function dedupeWithExceptionsIntegration(): Integration {
  const base = Sentry.dedupeIntegration()
  return {
    ...base,
    name: 'DedupeWithExceptions',
    processEvent(event: Event, hint: EventHint, client) {
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
      return base.processEvent ? base.processEvent(event, hint, client) : event
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
     * @sentry/browser@7.x: the functional integration constructors
     * for built-in BROWSER integrations (InboundFilters, TryCatch,
     * Breadcrumbs, GlobalHandlers, LinkedErrors, HttpContext,
     * FunctionToString) do NOT exist yet — only `dedupeIntegration()`
     * and `browserTracingIntegration()` were converted in v7.x. The
     * full functional-only API lands in @sentry/browser@8.x (separate
     * migration tracked).
     *
     * For the 7 built-ins below we keep the class form — but we
     * INSTANTIATE only (no subclassing). The TS-compatibility break
     * in 7.85+ was specifically on subclasses overriding `processEvent`
     * (method → property type change); plain instantiation continues
     * to typecheck and run correctly.
     *
     * The dedupe replacement uses the functional API because that's
     * what closed the original subclass-incompatibility AND the
     * underlying CVE (closer-to-current-line code in 7.119+).
     */
    defaultIntegrations: [
      new Sentry.Integrations.InboundFilters(),
      new Sentry.Integrations.FunctionToString(),
      new Sentry.Integrations.TryCatch(),
      new Sentry.Integrations.Breadcrumbs(),
      new Sentry.Integrations.GlobalHandlers(),
      new Sentry.Integrations.LinkedErrors(),
      dedupeWithExceptionsIntegration(),
      new Sentry.Integrations.HttpContext(),
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
