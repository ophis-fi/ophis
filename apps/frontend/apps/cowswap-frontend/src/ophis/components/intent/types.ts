/**
 * Shared types for the Ophis natural-language swap-intent feature.
 *
 * Mirrors the contract returned by the CF Pages Function at /api/intent.
 * See docs/development/specs/2026-05-08-ophis-intent-input-design.md.
 */

export type EntityType = 'sellToken' | 'buyToken' | 'amount' | 'chain'

export interface Entity {
  type: EntityType
  value: string
  raw: string
  start: number
  end: number
}

export interface ParsedIntent {
  intent: 'swap' | 'unknown'
  entities: Entity[]
}

export type IntentErrorCode =
  | 'TIMEOUT'
  | 'UPSTREAM'
  | 'INVALID_JSON'
  | 'BAD_INPUT'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'

export type IntentResponse =
  | { ok: true; data: ParsedIntent }
  | { ok: false; error: { code: IntentErrorCode; message: string } }
