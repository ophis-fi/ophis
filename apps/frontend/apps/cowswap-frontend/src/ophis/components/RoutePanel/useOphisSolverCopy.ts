import { useLingui } from '@lingui/react/macro'

/**
 * Localised wrappers around the solver display-alias layer.
 *
 * `ophisSolverPublicLabel` / `ophisSolverPublicDescription` in `ophis/solvers.ts`
 * return plain English strings. They are deliberately NOT lingui macros: that
 * module is imported by `scripts/check-solver-registry-invariant.sh` territory and
 * by non-React code, and it is the file the brand-neutrality test reads, so it
 * stays free of i18n machinery.
 *
 * The consequence is that rendering those return values directly leaves the solver
 * rows in English while the heading, count, lede and footer around them translate,
 * which reads as a broken panel in any non-English locale. This hook re-states the
 * same three outcomes as message descriptors so the whole panel translates.
 *
 * The mapping MUST stay in step with `ophisSolverPublicLabel`. It is asserted in
 * `useOphisSolverCopy.test.ts`: for every registry solver id, the English output
 * here has to equal the alias layer's output, so a new opt-in there cannot silently
 * fall through to the neutral label here.
 */
export interface OphisSolverCopy {
  label(solverId: string): string
  description(solverId: string): string
}

export function useOphisSolverCopy(): OphisSolverCopy {
  const { t } = useLingui()

  return {
    label(solverId: string): string {
      const normalizedSolverId = solverId.toLowerCase()

      if (normalizedSolverId === 'baseline') return t`Baseline`
      if (normalizedSolverId === 'uniswap-v4') return t`Ophis direct solver`

      // Safe by default, exactly as the alias layer is: any id that is not an
      // Ophis-run solver neutralizes, so a newly added third-party solver can
      // never leak its brand into rendered copy without an explicit opt-in.
      return t`External solver`
    },

    description(solverId: string): string {
      const normalizedSolverId = solverId.toLowerCase()

      if (normalizedSolverId === 'baseline') {
        return t`Ophis baseline solver routing over on-chain liquidity.`
      }
      if (normalizedSolverId === 'uniswap-v4') {
        return t`Ophis-operated direct solver routing through canonical on-chain liquidity.`
      }

      return t`An external solver competing in the Ophis batch auction to give you the best execution.`
    },
  }
}
