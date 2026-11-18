// Integer money: a decimal string as 18-decimal fixed point. Nothing here is a float. The desk (orders.ts)
// parses its amounts and prices with it. It imports nothing and reads no row. (Its example figures are gone: since
// 2026-11-14 an institution's Overview reads its own wallets and orders.)
const E = 10n ** 18n
/** A plain decimal string, as 18-decimal fixed point. Null: not a plain decimal, over 15 digits, or more decimals than `decimals`. */
export function fixed(text: unknown, decimals: number) {
  const m = typeof text === 'string' ? /^(0|[1-9]\d{0,14})(?:\.(\d{1,18}))?$/.exec(text) : null
  if (!m || (m[2]?.length ?? 0) > decimals) return null
  return BigInt(m[1]) * E + BigInt((m[2] ?? '').padEnd(18, '0'))
}
