import { createGlobalStyle } from 'styled-components/macro'

export const MobileSwapGlobalStyle = createGlobalStyle`
  :root {
    --ophis-font-display: Georgia, ui-serif, serif;
    --cow-font-family-primary: var(--ophis-font-body);
    --ophis-radius-xl: 24px;
    --ophis-space-3: 20px;
    @media (min-width: 721px) { --ophis-radius-xl: 20px; }
    color-scheme: light;
  }
  html, body { background: #ffffff; color: #17191c; }
  body, input, button, textarea {
    font-family: var(--ophis-font-body);
    font-variant-numeric: lining-nums tabular-nums;
  }
  button { min-height: 44px; }
  :focus-visible { outline: 2px solid #17191c; outline-offset: 3px; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
`
