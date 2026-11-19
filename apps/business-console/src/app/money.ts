/** A decimal string of the server with thousands separators and `dp` decimals (cut). Text only: no number is made of it.
 *  An amount above zero never reads as zero: below `dp` decimals its digits run to the first that is not 0 (0.00009, not
 *  0.0000; CodeRabbit, PR #1672). A module of its own, with no DOM, so that tests/worker.test.ts runs it. */
export function money(text: string, dp = 2) {
  const [whole, part = ''] = text.split('.')
  const shown = Math.max(dp, /^0*$/.test(whole) ? part.search(/[1-9]/) + 1 : 0)
  return `${whole.replace(/\B(?=(\d{3})+$)/g, ',')}${shown ? `.${part.padEnd(shown, '0').slice(0, shown)}` : ''}`
}
