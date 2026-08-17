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

type HttpError = { code: IntentErrorCode; message: string }
type PartialHttpError = { code?: IntentErrorCode; message?: string }

const EXACT_HTTP_ERRORS: Readonly<Record<number, HttpError>> = {
  401: { code: 'FORBIDDEN', message: 'request blocked' },
  403: { code: 'FORBIDDEN', message: 'request blocked' },
  408: { code: 'TIMEOUT', message: 'parser timed out' },
  429: { code: 'RATE_LIMITED', message: 'too many requests, slow down a moment' },
  504: { code: 'TIMEOUT', message: 'parser timed out' },
}

function defaultHttpError(status: number): HttpError {
  const exact = EXACT_HTTP_ERRORS[status]
  if (exact) return exact
  return status >= 400 && status < 500
    ? { code: 'BAD_INPUT', message: `request rejected (${status})` }
    : { code: 'UPSTREAM', message: `parser unavailable (${status})` }
}

async function readStructuredHttpError(res: Response): Promise<PartialHttpError | undefined> {
  try {
    const parsed = (await res.clone().json()) as { error?: PartialHttpError } | undefined
    return parsed?.error
  } catch {
    return undefined
  }
}

/**
 * Map an HTTP non-ok response to the closest IntentErrorCode and an
 * informative message. Attempts to extract `{ ok: false, error }`
 * from a JSON body if the server provided one (CF Pages function emits
 * structured errors for 4xx). Falls back to status-text defaults.
 *
 * Never throws — defensive against arbitrary CF/upstream HTML payloads.
 */
async function mapHttpStatus(res: Response): Promise<HttpError> {
  const bodyError = await readStructuredHttpError(res)
  const fallback = defaultHttpError(res.status)
  return {
    code: bodyError?.code ?? fallback.code,
    message: bodyError?.message ?? fallback.message,
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

function errorState(error: HttpError): IntentParseState {
  return { status: 'error', parsed: null, errorCode: error.code, errorMessage: error.message }
}

async function parseSuccessfulResponse(res: Response): Promise<IntentParseState> {
  let body: IntentResponse
  try {
    body = (await res.json()) as IntentResponse
  } catch {
    return errorState({ code: 'INVALID_JSON', message: 'response was not valid JSON' })
  }
  if (!body.ok) return errorState(body.error)

  const safeEntities = (Array.isArray(body.data?.entities) ? body.data.entities : []).filter(
    (entity) => entity != null && typeof (entity as { type?: unknown }).type === 'string',
  )
  return {
    status: 'ok',
    parsed: { ...body.data, entities: safeEntities },
    errorCode: null,
    errorMessage: null,
  }
}

async function parseIntentResponse(res: Response): Promise<IntentParseState> {
  return res.ok ? parseSuccessfulResponse(res) : errorState(await mapHttpStatus(res))
}

function networkErrorState(error: unknown): IntentParseState {
  const message = error instanceof Error && error.message ? error.message : 'network error'
  return errorState({ code: 'UPSTREAM', message })
}

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

      setState(await parseIntentResponse(res))
    } catch (err) {
      if (controller.signal.aborted) return
      if (requestId !== requestIdRef.current) return
      // True network-level failure (DNS, TLS, connection reset, fetch
      // aborted by something other than our controller). The browser
      // surfaces these as TypeError; map to UPSTREAM and try to keep the
      // original message for the toast.
      setState(networkErrorState(err))
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
