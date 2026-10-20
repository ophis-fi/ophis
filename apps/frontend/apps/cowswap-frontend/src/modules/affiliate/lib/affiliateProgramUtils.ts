import { REF_CODE_PATTERN } from '../config/affiliateProgram.const'

export function formatRefCode(value?: string | null): string | undefined {
  if (!value) return undefined
  const normalized = value.trim().toUpperCase()
  return REF_CODE_PATTERN.test(normalized) ? normalized : undefined
}
