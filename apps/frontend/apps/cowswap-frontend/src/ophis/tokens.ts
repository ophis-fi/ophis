/**
 * Ophis design tokens — source of truth.
 *
 * Token *system* (scale, naming, ramp shape, spacing rhythm) lifted from
 * Nucleus UI Lite (Gumroad, Lite tier). Token *values* are Ophis-specific:
 * a warm "sunset" saffron primary derived from the kit's gradient card studies
 * (`Auto Layout-2.svg`).
 *
 * Sunset rationale: every DEX aggregator (1inch, Velora, Jumper, Bungee,
 * Matcha) lives in the cool blue/purple/teal cluster. Warm tones make Ophis
 * visually unmistakable in a competitive screenshot — free brand recall.
 *
 * See docs/development/specs/2026-05-06-ophis-brand-foundations.md for license
 * notes, decisions, and the semantic-token mapping.
 *
 * NOTE: Dark mode is derived (Nucleus Lite ships light only).
 */

export const colors = {
  // Ophis's primary brand ramp — warm saffron (sunset). Contrast curve from
  // Nucleus (10 = pale tint near white, 60 = primary action, 100 = deep
  // near-black warm). Anchor `#f2a63e` (60) is the canonical sunset accent
  // used across every Ophis-native surface (header wordmark, hero, ds/
  // primitives, CTAs) and as cowswap's `primary` via getCowswapTheme.
  // `80 = #a85f0f` is the deeper saffron for light-mode text/contrast —
  // WCAG AA ~4.5:1 on white (Codex audit 2026-05-23; #d18a1f failed at 2.85:1).
  brand: {
    10: '#fef4e6',
    20: '#fce6c2',
    30: '#f9d195',
    40: '#f6bd63',
    50: '#f4b04a',
    60: '#f2a63e', // primary action, canonical saffron
    70: '#d98a22',
    80: '#a85f0f', // light-mode text/contrast (WCAG AA on white)
    90: '#6e3d08',
    100: '#3a2003',
  },
  // Secondary accent — magenta/rose. Used sparingly for highlights, gradient
  // stops, illustration. Derived from the gradient's bottom-right magenta peak.
  accent: {
    10: '#FFF0F6',
    20: '#FFD4E2',
    30: '#FFA9C2',
    40: '#F47AA0',
    50: '#E55A88',
    60: '#C73D6C', // secondary action / hover
    70: '#A02855',
    80: '#7A1A40',
    90: '#4A0E28',
    100: '#220612',
  },
  neutral: {
    10: '#F4F6F7',
    20: '#E8EBEB',
    30: '#DADDDE',
    40: '#C1C4C6',
    50: '#898D8F',
    60: '#6E7375',
    70: '#53575A',
    80: '#2F3133',
    90: '#1F2224',
    100: '#131214',
  },
  white: '#FFFFFF',
  green: {
    10: '#EBFAF0',
    20: '#D7F5E5',
    30: '#9BEBBF',
    40: '#51C285',
    50: '#23A15D',
    60: '#008557',
    70: '#006341',
    80: '#0D4F2B',
    90: '#053B1D',
    100: '#021F10',
  },
  red: {
    10: '#FFF3F0',
    20: '#FFE9E3',
    30: '#FFCEC2',
    40: '#FF9175',
    50: '#FF5226',
    60: '#DB340B',
    70: '#AD1D00',
    80: '#BA1700',
    90: '#611000',
    100: '#290800',
  },
  yellow: {
    10: '#FFF9E6',
    20: '#FFEFB3',
    30: '#FFD84D',
    40: '#ED9B16',
    50: '#D67507',
    60: '#B26205',
    70: '#824B0D',
    80: '#663C0C',
    90: '#4D2B05',
    100: '#331C03',
  },
  blue: {
    10: '#F2F7FF',
    20: '#E5F0FF',
    30: '#C2DCFF',
    40: '#75B1FF',
    50: '#3084FF',
    60: '#0A69FA',
    70: '#0050C7',
    80: '#003C94',
    90: '#042961',
    100: '#021026',
  },
} as const

export const fontFamily = {
  // Display face — Fraunces (OFL, variable). Warm humanist serif with a SOFT
  // axis that complements the sunset palette. Used for Display 1/2 and H1.
  display: '"Fraunces", ui-serif, Georgia, "Times New Roman", serif',
  // Body face — Plus Jakarta Sans (OFL, variable). Geometric humanist sans,
  // tabular figures available, pairs cleanly with Fraunces.
  primary: '"Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
} as const

export const fontSize = {
  xs: '12px',
  sm: '14px',
  md: '16px',
  lg: '18px',
  xl: '24px',
  '2xl': '32px',
  '3xl': '40px',
  '4xl': '64px',
} as const

export const fontWeight = {
  light: 300,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const

export const lineHeight = {
  display: 1.2,
  heading: 1.2,
  body: 1.5,
} as const

export const textStyles = {
  display1: { size: fontSize['4xl'], weight: fontWeight.bold, lineHeight: lineHeight.display, family: fontFamily.display },
  display2: { size: fontSize['3xl'], weight: fontWeight.bold, lineHeight: lineHeight.display, family: fontFamily.display },
  h1: { size: fontSize['2xl'], weight: fontWeight.bold, lineHeight: lineHeight.heading, family: fontFamily.display },
  h2: { size: fontSize.xl, weight: fontWeight.bold, lineHeight: lineHeight.heading, family: fontFamily.primary },
  h3: { size: fontSize.lg, weight: fontWeight.bold, lineHeight: lineHeight.heading, family: fontFamily.primary },
  h4: { size: fontSize.md, weight: fontWeight.bold, lineHeight: lineHeight.heading, family: fontFamily.primary },
  h5: { size: fontSize.sm, weight: fontWeight.bold, lineHeight: lineHeight.heading, family: fontFamily.primary },
  h6: { size: fontSize.xs, weight: fontWeight.bold, lineHeight: lineHeight.heading, family: fontFamily.primary },
  bodyLg: { size: fontSize.lg, weight: fontWeight.regular, lineHeight: lineHeight.body, family: fontFamily.primary },
  bodyMd: { size: fontSize.md, weight: fontWeight.regular, lineHeight: lineHeight.body, family: fontFamily.primary },
  bodySm: { size: fontSize.sm, weight: fontWeight.regular, lineHeight: lineHeight.body, family: fontFamily.primary },
  bodyXs: { size: fontSize.xs, weight: fontWeight.regular, lineHeight: lineHeight.body, family: fontFamily.primary },
  labelLg: { size: fontSize.lg, weight: fontWeight.bold, lineHeight: lineHeight.body, family: fontFamily.primary },
  labelMd: { size: fontSize.md, weight: fontWeight.bold, lineHeight: lineHeight.body, family: fontFamily.primary },
  labelSm: { size: fontSize.sm, weight: fontWeight.bold, lineHeight: lineHeight.body, family: fontFamily.primary },
  labelXs: { size: fontSize.xs, weight: fontWeight.bold, lineHeight: lineHeight.body, family: fontFamily.primary },
  mono: { size: fontSize.sm, weight: fontWeight.regular, lineHeight: lineHeight.body, family: fontFamily.mono },
} as const

export const space = {
  0: '0',
  1: '4px',
  2: '8px',
  3: '12px',
  4: '16px',
  5: '24px',
  6: '32px',
  7: '40px',
  8: '48px',
  9: '56px',
  10: '64px',
  11: '72px',
  12: '80px',
} as const

export const radius = {
  none: '0',
  sm: '4px',
  md: '8px',
  lg: '16px',
  xl: '32px',
  full: '9999px',
} as const

export const stroke = {
  none: '0',
  sm: '1px',
  md: '2px',
  lg: '4px',
  xl: '8px',
} as const

export const shadow = {
  low: '0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.06)',
  medium: '0 4px 6px rgba(0,0,0,0.04), 0 8px 16px rgba(0,0,0,0.06)',
  high: '0 12px 24px rgba(0,0,0,0.08), 0 24px 48px rgba(0,0,0,0.12)',
  focus: `0 0 0 3px ${colors.brand[40]}`,
} as const

// Sunset gradient — hero / marketing / receipt artwork. NOT for UI affordances
// (use solid `brand` tokens for buttons, links, etc.). Stops sampled from
// `Auto Layout-2.svg`.
export const gradient = {
  sunset: 'linear-gradient(135deg, #FF8A52 0%, #FF6B5A 30%, #E55A88 65%, #A44E91 100%)',
  sunsetSoft: 'linear-gradient(135deg, #FFE0CE 0%, #FFCABE 35%, #F8B8CC 70%, #D5B6D8 100%)',
  // Radial wash (for hero blocks, card backgrounds)
  sunsetRadial: 'radial-gradient(120% 80% at 20% 20%, #FF8A52 0%, #E66A55 40%, #C73D6C 75%, #5C1D14 100%)',
} as const

export const semantic = {
  light: {
    bg: { page: colors.white, surface: colors.white, subtle: colors.neutral[10], muted: colors.neutral[20] },
    text: { primary: colors.neutral[100], secondary: colors.neutral[70], muted: colors.neutral[50], inverse: colors.white },
    border: { subtle: colors.neutral[20], default: colors.neutral[30], strong: colors.neutral[50] },
    accent: { primary: colors.brand[60], hover: colors.brand[70], pressed: colors.brand[80], subtleBg: colors.brand[10], text: colors.brand[70] },
    state: { success: colors.green[50], warning: colors.yellow[40], danger: colors.red[50], info: colors.blue[50] },
  },
  dark: {
    bg: { page: colors.neutral[100], surface: colors.neutral[90], subtle: colors.neutral[80], muted: colors.neutral[70] },
    text: { primary: colors.neutral[10], secondary: colors.neutral[30], muted: colors.neutral[50], inverse: colors.neutral[100] },
    border: { subtle: colors.neutral[80], default: colors.neutral[70], strong: colors.neutral[50] },
    accent: { primary: colors.brand[50], hover: colors.brand[40], pressed: colors.brand[30], subtleBg: colors.brand[90], text: colors.brand[30] },
    state: { success: colors.green[40], warning: colors.yellow[30], danger: colors.red[40], info: colors.blue[40] },
  },
} as const

export type SemanticTokens = typeof semantic.light
