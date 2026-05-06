import { Middleware } from '@reduxjs/toolkit'

import { AppState } from '../index'

/**
 * vCOW → COW token-conversion middleware (no-op on Greg).
 *
 * Upstream this middleware listened for finalized swapVCow / swapLockedGNOvCow
 * transactions and played a CoW success/error sound. vCOW is CoW DAO's locked
 * governance token — Greg does not surface that conversion route to users, so
 * the middleware never has work to do here.
 *
 * Kept as a pass-through (rather than deleted) so the redux registration site
 * does not need to know about the strip. Remove once the cowToken slice itself
 * is dropped from the store.
 */
export const cowTokenMiddleware: Middleware<Record<string, unknown>, AppState> = () => (next) => (action) =>
  next(action)
