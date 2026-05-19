/**
 * Hook: debounced LLM parse of the natural-language swap input.
 *
 * Owns: 400ms debounce, abortable fetch to /api/intent, in-flight tracking,
 * stale-response guard via AbortController + a request-id watermark.
 *
 * The endpoint is the CF Pages Function defined at functions/api/intent.ts.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { IntentErrorCode, IntentResponse, ParsedIntent } from './types'

const DEBOUNCE_MS = 400
const ENDPOINT = '/api/intent'

/**
 * Map an HTTP non-ok response to the closest IntentErrorCode and an
 * informative message. Attempts to extract `{ ok: false, error }`
 * from a JSON body if the server provided one (CF Pages function emits
 * structured errors for 4xx). Falls back to status-text defaults.
 *
 * Never throws — defensive against arbitrary CF/upstream HTML payloads.
 */
async function mapHttpStatus(
  res: Response,
): Promise<{ code: IntentErrorCode; message: string }> {
  // Try to extract a structured error first.
  let bodyErr: { code?: IntentErrorCode; message?: string } | undefined
  try {
    const cloned = res.clone()
    const parsed = (await cloned.json()) as { error?: typeof bodyErr } | undefined
    bodyErr = parsed?.error
  } catch {
    // Non-JSON body — fine, fall back to status-only mapping.
  }

  if (res.status === 429) {
    return {
      code: bodyErr?.code ?? 'RATE_LIMITED',
      message: bodyErr?.message ?? 'too many requests — slow down a moment',
    }
  }
  if (res.status === 401 || res.status === 403) {
    return {
      code: bodyErr?.code ?? 'FORBIDDEN',
      message: bodyErr?.message ?? 'request blocked',
    }
  }
  if (res.status === 408 || res.status === 504) {
    return {
      code: bodyErr?.code ?? 'TIMEOUT',
      message: bodyErr?.message ?? 'parser timed out',
    }
  }
  if (res.status >= 400 && res.status < 500) {
    return {
      code: bodyErr?.code ?? 'BAD_INPUT',
      message: bodyErr?.message ?? `request rejected (${res.status})`,
    }
  }
  // 5xx — upstream LLM down, CF tunnel hiccup, Workers OOM, etc.
  return {
    code: bodyErr?.code ?? 'UPSTREAM',
    message: bodyErr?.message ?? `parser unavailable (${res.status})`,
  }
}

export type IntentParseStatus = 'idle' | 'pending' | 'ok' | 'error'

export interface IntentParseState {
  status: IntentParseStatus
  parsed: ParsedIntent | null
  errorCode: IntentErrorCode | null
  errorMessage: string | null
}

const INITIAL: IntentParseState = { status: 'idle', parsed: null, errorCode: null, errorMessage: null }

export function useIntentParse(text: string): IntentParseState {
  const [state, setState] = useState<IntentParseState>(INITIAL)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)

  const fire = useCallback(async (input: string, requestId: number) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setState((s) => ({ ...s, status: 'pending', errorCode: null, errorMessage: null }))

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: input }),
      })

      // Drop stale responses (user kept typing).
      if (requestId !== requestIdRef.current) return

      // Phase 3 audit M (2026-05-19): HTTP status branching.
      //
      // Pre-fix: the code went straight to `res.json()` without checking
      // `res.ok`. If the server returned a 5xx HTML error page (CF tunnel
      // hiccup, Workers OOM, 429 plain-text from rate limiter), JSON
      // parse threw and the catch generic'd everything as
      // `code='UPSTREAM', message='network error'`. The user got the
      // same opaque toast whether they hit our rate limit, an upstream
      // LLM outage, or were genuinely blocked.
      //
      // Post-fix: read status first, map to a specific IntentErrorCode,
      // and try to extract a richer message from the body if it happens
      // to be JSON. Non-JSON 4xx/5xx bodies are fine — we keep the
      // status-derived defaults.
      if (!res.ok) {
        const fallback = await mapHttpStatus(res)
        setState({ status: 'error', parsed: null, errorCode: fallback.code, errorMessage: fallback.message })
        return
      }

      // 2xx but body might still be a structured `{ ok: false, error }`
      // (the CF Pages function returns 200 + ok:false for some user-input
      // errors). JSON parse can still fail if the function returned an
      // unexpected shape — branch that separately so we get
      // INVALID_JSON instead of a generic UPSTREAM mask.
      let body: IntentResponse
      try {
        body = (await res.json()) as IntentResponse
      } catch {
        setState({ status: 'error', parsed: null, errorCode: 'INVALID_JSON', errorMessage: 'response was not valid JSON' })
        return
      }
      if (!body.ok) {
        setState({ status: 'error', parsed: null, errorCode: body.error.code, errorMessage: body.error.message })
        return
      }
      setState({ status: 'ok', parsed: body.data, errorCode: null, errorMessage: null })
    } catch (err) {
      if (controller.signal.aborted) return
      if (requestId !== requestIdRef.current) return
      // True network-level failure (DNS, TLS, connection reset, fetch
      // aborted by something other than our controller). The browser
      // surfaces these as TypeError; map to UPSTREAM and try to keep the
      // original message for the toast.
      const msg = err instanceof Error && err.message ? err.message : 'network error'
      setState({ status: 'error', parsed: null, errorCode: 'UPSTREAM', errorMessage: msg })
    }
  }, [])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    abortRef.current?.abort()

    const trimmed = text.trim()
    if (trimmed.length < 3) {
      setState(INITIAL)
      return
    }

    const id = ++requestIdRef.current
    timerRef.current = setTimeout(() => {
      fire(trimmed, id)
    }, DEBOUNCE_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [text, fire])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return state
}
