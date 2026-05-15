import { useCallback, useEffect, useState } from 'react'

import ms from 'ms.macro'

import { getTelegramAuth } from '../services/getTelegramAuth'
import { TelegramData } from '../types'

const TG_SESSION_CHECK_INTERVAL = ms`3s`

// Ophis fork: Telegram OAuth is only wired up when the deployment has its own
// notifications bot configured via REACT_APP_TG_BOT_ID. Without one, calling
// oauth.telegram.org from a non-cow.fi origin triggers a CORS error on every
// page load (CoW's bot only allowlists cow.fi). When unset, the hooks below
// short-circuit so no network call is ever made.
const ENV_TG_BOT_ID = process.env.REACT_APP_TG_BOT_ID
const TG_BOT_ID = ENV_TG_BOT_ID ? parseInt(ENV_TG_BOT_ID) : null

const AUTH_OPTIONS = TG_BOT_ID
  ? {
      bot_id: TG_BOT_ID,
      lang: 'en',
      request_access: 'write',
    }
  : null

export interface TgAuthorization {
  tgData: TelegramData | null
  authorize(): Promise<TelegramData | null>
  authenticate(): Promise<TelegramData | null>
  clearAuth(): void
  isAuthChecked: boolean
  isLoginInProgress: boolean
}

export function useTgAuthorization(): TgAuthorization {
  const [tgData, setTgData] = useState<TelegramData | null>(null)
  const [isAuthChecked, setIsAuthChecked] = useState<boolean>(false)
  const [isLoginInProgress, setIsLoginInProgress] = useState<boolean>(false)

  const authenticate = useCallback((): Promise<TelegramData | null> => {
    return new Promise((resolve) => {
      if (!TG_BOT_ID) {
        setIsAuthChecked(true)
        resolve(null)
        return
      }
      getTelegramAuth(TG_BOT_ID, (response) => {
        const tgData = (response && response.user) || null

        setTgData(tgData)
        setIsAuthChecked(true)
        resolve?.(tgData)
      })
    })
  }, [])

  const authorize = useCallback(async (): Promise<TelegramData | null> => {
    if (!window.Telegram || !AUTH_OPTIONS) return null

    setIsLoginInProgress(true)

    return new Promise((resolve) => {
      window.Telegram?.Login.auth(AUTH_OPTIONS, (data) => {
        if (data) {
          setTgData(data)
          setIsLoginInProgress(false)
          resolve(data)
        } else {
          authenticate().then((tgData) => {
            setTgData(tgData)
            setIsLoginInProgress(false)
            resolve(tgData)
          })
        }
      })
    })
  }, [authenticate])

  const clearAuth = useCallback((): void => {
    setTgData(null)
    setIsAuthChecked(true) // Keep checked state to avoid re-checking
  }, [])

  /**
   * Initial authentication check on mount
   */
  useEffect(() => {
    authenticate()
  }, [authenticate])

  /**
   * Periodically check if the user is already authenticated
   */
  useEffect(() => {
    if (!tgData) return

    const intervalId = setInterval(authenticate, TG_SESSION_CHECK_INTERVAL)

    return () => {
      clearInterval(intervalId)
    }
  }, [tgData, authenticate])

  return { authorize, authenticate, clearAuth, tgData, isAuthChecked, isLoginInProgress }
}
