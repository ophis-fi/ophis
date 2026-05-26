# Brand reference

Single-page snapshot of Ophis's visual system. Open `sheet.html` locally for the
live render (loads Fraunces / Plus Jakarta / JetBrains Mono from Google Fonts;
the Ophie animated states play in-browser). `sheet.png` is the rasterized
fallback at 1600×~2200 for quick previews and PR comments.

What's on the sheet:

- **Logo variants** — coral workhorse, cream inverse, on neutral, sunset hero.
- **Animated states** — `OphieSpinner` at full size, plus three rotation
  speeds (slow / normal / fast) showing the favicon cycle.
- **Components** — pill button hierarchy (BIG/DEFAULT/SMALL secondary), tabs
  with coral underline, snackbar with `--ophis-shadow-medium`.
- **Color anchor** — `brand/10..100` ramp with `brand/60 #E66A55` as the
  primary action anchor (★).

Source-of-truth files:

| Concept | Source |
|---|---|
| Tokens | `apps/frontend/apps/cowswap-frontend/src/ophis/tokens.ts` |
| CSS variables | `apps/frontend/apps/cowswap-frontend/src/ophis/styles.css` |
| Theme override | `apps/frontend/apps/cowswap-frontend/src/theme/getCowswapTheme.ts` |
| Logo path data | `apps/frontend/apps/cowswap-frontend/src/ophis/ophiePath.ts` |
| Logo mark (rendered) | `apps/frontend/apps/cowswap-frontend/src/ophis/components/OphieMark.tsx` |
| Favicon frames | `apps/frontend/apps/cowswap-frontend/src/assets/animated-favicon/` |
| OG card | `apps/frontend/apps/cowswap-frontend/public/og-image.png` |
| Ophis components | `apps/frontend/apps/cowswap-frontend/src/ophis/components/` |

Regenerate `sheet.png` from `sheet.html`:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=1600,2200 \
  --screenshot=docs/brand/sheet.png \
  "file://$(pwd)/docs/brand/sheet.html"
```
