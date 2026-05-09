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

export type IntentParseStatus = 'idle' | 'pending' | 'ok' | 'error'

export interface IntentParseState {
  status: IntentParseStatus
  parsed: ParsedIntent | null
  errorCode: IntentErrorCode | null
}

const INITIAL: IntentParseState = { status: 'idle', parsed: null, errorCode: null }

export function useIntentParse(text: string): IntentParseState {
  const [state, setState] = useState<IntentParseState>(INITIAL)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)

  const fire = useCallback(async (input: string, requestId: number) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setState((s) => ({ ...s, status: 'pending', errorCode: null }))

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: input }),
      })

      // Drop stale responses (user kept typing).
      if (requestId !== requestIdRef.current) return

      const body = (await res.json()) as IntentResponse
      if (!body.ok) {
        setState({ status: 'error', parsed: null, errorCode: body.error.code })
        return
      }
      setState({ status: 'ok', parsed: body.data, errorCode: null })
    } catch (err) {
      if (controller.signal.aborted) return
      if (requestId !== requestIdRef.current) return
      setState({ status: 'error', parsed: null, errorCode: 'UPSTREAM' })
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
