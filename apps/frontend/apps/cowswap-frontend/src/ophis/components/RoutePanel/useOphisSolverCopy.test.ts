import { renderHook } from '@testing-library/react'

import { useOphisSolverCopy } from './useOphisSolverCopy'

import { OPHIS_SOLVERS, ophisSolverPublicDescription, ophisSolverPublicLabel } from '../../solvers'

jest.mock('@lingui/react', () => ({
  ...jest.requireActual('@lingui/react'),
  // Echo the source message so the English output of the localised layer is
  // directly comparable to the plain-string alias layer.
  useLingui: () => ({
    i18n: {
      _: (descriptor: { message?: string; id?: string } | string) =>
        typeof descriptor === 'string' ? descriptor : (descriptor.message ?? descriptor.id ?? ''),
    },
    _: (descriptor: { message?: string; id?: string } | string) =>
      typeof descriptor === 'string' ? descriptor : (descriptor.message ?? descriptor.id ?? ''),
  }),
}))

/**
 * The localised layer restates the alias layer's three outcomes as lingui
 * messages, because `ophis/solvers.ts` deliberately stays free of i18n machinery.
 * Restating means two copies, so this pins them together: if someone adds an
 * Ophis-run solver to `ophisSolverPublicLabel` and forgets the hook, that solver
 * would silently render as "External solver" in every locale including English.
 */
describe('useOphisSolverCopy', () => {
  it('matches the alias layer in English for every registry solver', () => {
    const { result } = renderHook(() => useOphisSolverCopy())

    for (const { solverId } of OPHIS_SOLVERS) {
      expect(result.current.label(solverId)).toBe(ophisSolverPublicLabel(solverId))
      expect(result.current.description(solverId)).toBe(ophisSolverPublicDescription(solverId))
    }
  })

  it('neutralizes an unknown solver id, exactly as the alias layer does', () => {
    const { result } = renderHook(() => useOphisSolverCopy())

    // Safe by default: a newly added third-party solver cannot leak its brand
    // without an explicit opt-in in BOTH layers.
    for (const unknownId of ['some-new-aggregator', 'KyberSwap', 'odos']) {
      expect(result.current.label(unknownId)).toBe('External solver')
      expect(result.current.label(unknownId)).toBe(ophisSolverPublicLabel(unknownId))
    }
  })

  it('is case-insensitive on the solver id, like the alias layer', () => {
    const { result } = renderHook(() => useOphisSolverCopy())

    expect(result.current.label('BASELINE')).toBe('Baseline')
    expect(result.current.label('Uniswap-V4')).toBe('Ophis direct solver')
  })
})
