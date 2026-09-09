import { createGlobalStyle } from 'styled-components/macro'

export const MobileSwapGlobalStyle = createGlobalStyle`
  @font-face {
    font-family: 'Ophis Inter';
    src: url('/static/Inter-roman.var.woff2') format('woff2');
    font-weight: 100 900;
    font-display: swap;
  }
  :root {
    --ophis-font-body: 'Ophis Inter', Inter, system-ui, sans-serif;
    --ophis-font-display: Georgia, ui-serif, serif;
    --cow-font-family-primary: var(--ophis-font-body);
    --ophis-radius-xl: 24px;
    --ophis-space-3: 20px;
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
