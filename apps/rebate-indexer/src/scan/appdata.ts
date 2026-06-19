import { APP_CODES, type AppCode } from '../cow/types.js';

export interface AppDataInfo {
  appCode: AppCode | null;
  refCode: string | null;
  feeBps: number | null;
}

const REF_RE = /^[a-z0-9_-]{3,64}$/;

export function parseAppData(fullAppData: string | null | undefined): AppDataInfo {
  const empty: AppDataInfo = { appCode: null, refCode: null, feeBps: null };
  if (!fullAppData) return empty;
  let meta: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fullAppData);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    meta = parsed as Record<string, unknown>;
  } catch {
    return empty;
  }
  const rawCode = (meta as { appCode?: unknown }).appCode;
  const appCode = typeof rawCode === 'string' && (APP_CODES as readonly string[]).includes(rawCode)
    ? (rawCode as AppCode)
    : null;

  const metadata = (meta as { metadata?: Record<string, unknown> }).metadata ?? {};
  let refCode: string | null = null;
  const rawRef = (metadata as { ophisReferrer?: { code?: unknown } }).ophisReferrer?.code;
  if (typeof rawRef === 'string') {
    const c = rawRef.trim().toLowerCase();
    if (REF_RE.test(c)) refCode = c;
  }
  const rawBps = (metadata as { partnerFee?: { volumeBps?: unknown } }).partnerFee?.volumeBps;
  const feeBps = typeof rawBps === 'number' && Number.isInteger(rawBps) && rawBps >= 0 && rawBps <= 10000 ? rawBps : null;

  return { appCode, refCode, feeBps };
}
