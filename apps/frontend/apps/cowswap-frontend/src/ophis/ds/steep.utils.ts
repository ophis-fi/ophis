/**
 * Steep palette selector for ophis/ds primitives + Ophis header/footer.
 *
 * Every value references the `--ophis-steep-*` vars in
 * `ophis/styles.css` with a hex fallback, so primitives render even if
 * the sheet loads late. Light is the default; the neutral-ink dark
 * variant is selected via `theme.darkMode` (the app persists a dark
 * default — see theme/themeConfigAtom.ts), never via OS media query.
 *
 * The peach/brown pair is reserved for the `planned` tone (light AND
 * dark): one warm surface per page, per the approved Steep reference.
 * Status tones use restrained functional hues that hold WCAG AA
 * against their tinted fills.
 */

export interface SteepThemeFlag {
  darkMode?: boolean
}

export function isSteepDark(theme?: SteepThemeFlag | null): boolean {
  return theme?.darkMode === true
}

export interface SteepTone {
  text: string
  border: string
  bg: string
}

export type SteepToneName =
  | 'live'
  | 'planned'
  | 'beta'
  | 'partner'
  | 'draft'
  | 'audit'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'

export interface SteepPalette {
  /** Primary body text. */
  text: string
  /** Secondary text for ledes/intros (large sizes only on light). */
  secondary: string
  /** Small-size muted text (labels, captions, eyebrows). AA-safe. */
  muted: string
  /** Non-essential faint text (large sizes only). */
  faint: string
  /** Card / raised surface. */
  card: string
  /** Card resting border / hairline. */
  cardBorder: string
  /** Card hover border. */
  hoverBorder: string
  /** Inline-code + data-chip fill. */
  codeBg: string
  /** Link + focus-ring color. */
  link: string
  /** Table header band. */
  tableHead: string
  /** Table row hover wash. */
  rowHover: string
  tones: Record<SteepToneName, SteepTone>
}

const LIGHT: SteepPalette = {
  text: 'var(--ophis-steep-ink, #17191c)',
  secondary: 'var(--ophis-steep-slate, #777b86)',
  muted: 'var(--ophis-steep-muted, #5b606b)',
  faint: 'var(--ophis-steep-ash, #979799)',
  card: 'var(--ophis-steep-paper, #ffffff)',
  cardBorder: 'var(--ophis-steep-hair, #e8e8ea)',
  hoverBorder: 'var(--ophis-steep-line, #d9d9dc)',
  codeBg: 'var(--ophis-steep-mist, #f2f2f3)',
  link: 'var(--ophis-steep-ink, #17191c)',
  tableHead: 'var(--ophis-steep-fog, #fafafb)',
  rowHover: 'var(--ophis-steep-fog, #fafafb)',
  tones: {
    live: {
      text: 'var(--ophis-steep-success, #1c6b3f)',
      border: '#bfe0cd',
      bg: 'var(--ophis-steep-success-bg, #e9f4ee)',
    },
    planned: { text: 'var(--ophis-steep-brown, #5d2a1a)', border: '#e8c4a8', bg: 'var(--ophis-steep-peach, #fbe1d1)' },
    beta: {
      text: 'var(--ophis-steep-info, #3d4450)',
      border: 'var(--ophis-steep-line, #d9d9dc)',
      bg: 'var(--ophis-steep-info-bg, #eef0f3)',
    },
    partner: { text: 'var(--ophis-steep-brown, #5d2a1a)', border: '#e8c4a8', bg: 'var(--ophis-steep-paper, #ffffff)' },
    draft: {
      text: 'var(--ophis-steep-muted, #5b606b)',
      border: 'var(--ophis-steep-hair, #e8e8ea)',
      bg: 'var(--ophis-steep-mist, #f2f2f3)',
    },
    audit: {
      text: 'var(--ophis-steep-success, #1c6b3f)',
      border: '#bfe0cd',
      bg: 'var(--ophis-steep-success-bg, #e9f4ee)',
    },
    info: {
      text: 'var(--ophis-steep-info, #3d4450)',
      border: 'var(--ophis-steep-line, #d9d9dc)',
      bg: 'var(--ophis-steep-info-bg, #eef0f3)',
    },
    success: {
      text: 'var(--ophis-steep-success, #1c6b3f)',
      border: '#bfe0cd',
      bg: 'var(--ophis-steep-success-bg, #e9f4ee)',
    },
    warning: {
      text: 'var(--ophis-steep-warning, #7c4a03)',
      border: '#e3cf9e',
      bg: 'var(--ophis-steep-warning-bg, #faeed3)',
    },
    danger: {
      text: 'var(--ophis-steep-error, #8a2b1a)',
      border: '#eec2b6',
      bg: 'var(--ophis-steep-danger-bg, #fbe9e2)',
    },
  },
}

const DARK: SteepPalette = {
  text: 'var(--ophis-steep-dark-text, #f4f4f5)',
  secondary: 'var(--ophis-steep-dark-muted, #a3a6af)',
  muted: 'var(--ophis-steep-dark-muted, #a3a6af)',
  faint: 'var(--ophis-steep-dark-faint, #777b86)',
  card: 'var(--ophis-steep-dark-card, #1e2126)',
  cardBorder: 'var(--ophis-steep-dark-hair, #2e333a)',
  hoverBorder: 'var(--ophis-steep-dark-line, #3a4048)',
  codeBg: 'var(--ophis-steep-dark-card, #1e2126)',
  link: 'var(--ophis-steep-dark-text, #f4f4f5)',
  tableHead: 'var(--ophis-steep-dark-card, #1e2126)',
  rowHover: 'rgba(244, 244, 245, 0.04)',
  tones: {
    live: { text: '#7fd6a4', border: 'rgba(127, 214, 164, 0.35)', bg: 'rgba(127, 214, 164, 0.08)' },
    planned: { text: 'var(--ophis-steep-brown, #5d2a1a)', border: '#e8c4a8', bg: 'var(--ophis-steep-peach, #fbe1d1)' },
    beta: { text: '#c3c9d4', border: 'rgba(195, 201, 212, 0.3)', bg: 'rgba(195, 201, 212, 0.07)' },
    partner: { text: '#e8c4a8', border: 'rgba(232, 196, 168, 0.4)', bg: 'rgba(232, 196, 168, 0.08)' },
    draft: {
      text: 'var(--ophis-steep-dark-muted, #a3a6af)',
      border: 'rgba(163, 166, 175, 0.3)',
      bg: 'rgba(163, 166, 175, 0.07)',
    },
    audit: { text: '#7fd6a4', border: 'rgba(127, 214, 164, 0.35)', bg: 'rgba(127, 214, 164, 0.08)' },
    info: { text: '#c3c9d4', border: 'rgba(195, 201, 212, 0.3)', bg: 'rgba(195, 201, 212, 0.07)' },
    success: { text: '#7fd6a4', border: 'rgba(127, 214, 164, 0.35)', bg: 'rgba(127, 214, 164, 0.08)' },
    warning: { text: '#f0c46c', border: 'rgba(240, 196, 108, 0.4)', bg: 'rgba(240, 196, 108, 0.08)' },
    danger: { text: '#ff9d8a', border: 'rgba(255, 157, 138, 0.4)', bg: 'rgba(255, 157, 138, 0.08)' },
  },
}

export function steep(theme?: SteepThemeFlag | null): SteepPalette {
  return isSteepDark(theme) ? DARK : LIGHT
}

export const STEEP_FONT = {
  display: `var(--ophis-font-display, Georgia, 'Times New Roman', ui-serif, serif)`,
  body: `var(--ophis-font-body, Inter, system-ui, -apple-system, 'Segoe UI', sans-serif)`,
  mono: `var(--ophis-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)`,
} as const
