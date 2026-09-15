import { Color, ThemeColorVars } from '@cowprotocol/ui'

import variables from 'components/layout/GenericLayout/variablesCss'
import { createGlobalStyle } from 'styled-components/macro'

export const StaticGlobalStyle = createGlobalStyle`
  /* TEMPORARY: import variables */
  ${variables}

  :focus-visible { outline: 2px solid #5d2a1a; outline-offset: 3px; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }

  .noScroll {
    overflow: hidden;
  }

  .not-implemented {
    display: none !important
  }

  html, body {
    width: 100%;
    margin: 0;
    font-size: 62.5%;
    text-rendering: geometricPrecision;
    line-height: 10px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    box-sizing: border-box;
    overscroll-behavior-y: none;
    scroll-behavior: smooth;
  }

  *, *:before, *:after {
    box-sizing: inherit;
  }

  /* TODO: move closer to H elements or sth */
  h1, h2, h3 {
    margin: 0.5rem 0;
  }
  h1 {
    font-family: Georgia, serif;
    font-weight: 400;
    font-size: 1.8rem;
  }
  h2 {
    font-size: 1.6rem;
  }
`

export const ThemedGlobalStyle = createGlobalStyle`
  // Global CoW DAO styles
  ${ThemeColorVars}

  input,
  textarea,
  button,
  select {
    font-family: ${({ theme }): string => theme.fontDefault}, sans-serif;
  }
  @supports (font-variation-settings: normal) {
    input,
    textarea,
    button,
    select {
      font-family: ${({ theme }): string => theme.fontVariable}, sans-serif;
    }
  }
  html, body {
    background: ${Color.explorer_bg};
    color: ${Color.explorer_textPrimary};
    /* StyleLint fights you for the sans-serif as it requires a fallback and can't detect it from the theme prop */
    font-family: ${({ theme }): string => theme.fontDefault}, sans-serif;
    font-variant-numeric: lining-nums tabular-nums;

    @supports (font-variation-settings: normal) {
      font-family: ${({ theme }): string => theme.fontVariable}, sans-serif;
    }
  }

  /* TODO: move closer to <a> element */
  a {
    &:hover {
      text-decoration: underline;
    }

    text-decoration: none;
    cursor: pointer;

    &:link,
    &:visited {
      color: ${Color.explorer_textActive};
    }
  }
`
