/**
 * Brand kit — logo variants + color tokens + typography spec + usage
 * guidelines.
 *
 * Phase A3 rebuild (PR #250, 2026-05-23). Replaces local
 * styled-components with ophis/ds primitives. The visual structure of
 * the prior page was actually close to right (logo grid + color cards +
 * font samples); this rewrite mostly swaps the chrome and adds usage
 * specificity.
 *
 * Steep refresh: swatches and type samples follow the approved
 * editorial palette (ink / paper / mist / fog / peach / sienna) and
 * the Georgia + Inter/system type pairing.
 */
import { ReactNode } from 'react'

import {
  Badge,
  Callout,
  FeatureGrid,
  InlineCode,
  PageShell,
  Section,
  STEEP_FONT,
  steep,
  Table,
  Tbody,
  Td,
  TextLink,
  Th,
  Thead,
  Tr,
} from 'ophis/ds'
import styled from 'styled-components/macro'

// Visual swatches and typography samples live in this file because they
// don't generalize to the rest of the design system — a brand-kit page
// is the one place where you DO want display-only chrome.
const LogoTile = styled.div<{ $dark?: boolean }>`
  color: ${({ theme, $dark }) => ($dark ? '#f4f4f5' : steep(theme).text)};
  border-radius: 16px;
  padding: 32px 18px 18px;
  background: ${({ theme, $dark }) => ($dark ? 'var(--ophis-steep-ink, #17191c)' : steep(theme).card)};
  border: 1px solid ${({ theme }) => steep(theme).cardBorder};
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;

  & img {
    height: 48px;
    width: auto;
  }
`

const LogoMeta = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  font-size: 13px;
  color: inherit;
  text-align: center;
`

const DownloadLink = styled.a`
  color: inherit;
  font-size: 12px;
  font-weight: 500;
  text-decoration: none;
  &:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => steep(theme).link};
    outline-offset: 2px;
    border-radius: 2px;
  }
`

const ColorSwatch = styled.div<{ $bg: string; $fg: string }>`
  border-radius: 16px;
  padding: 24px 20px;
  background: ${({ $bg }) => $bg};
  color: ${({ $fg }) => $fg};
  border: 1px solid ${({ theme }) => steep(theme).cardBorder};
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 130px;

  & h3 {
    margin: 0;
    font-family: ${STEEP_FONT.body};
    font-size: 16px;
    font-weight: 500;
  }
  & code {
    font-family: ${STEEP_FONT.mono};
    font-size: 13px;
    opacity: 0.85;
  }
  & span {
    font-size: 12px;
    opacity: 0.8;
    line-height: 1.5;
  }
`

const FontSample = styled.div<{ $family: string }>`
  border-radius: 16px;
  padding: 24px 20px;
  background: ${({ theme }) => steep(theme).card};
  border: 1px solid ${({ theme }) => steep(theme).cardBorder};
  font-family: ${({ $family }) => $family};
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 140px;

  & .sample {
    font-size: 28px;
    line-height: 1.1;
    color: ${({ theme }) => steep(theme).text};
  }
  & .name {
    font-size: 13px;
    color: ${({ theme }) => steep(theme).muted};
    font-family: ${STEEP_FONT.body};
  }
  & .role {
    font-size: 12px;
    color: ${({ theme }) => steep(theme).muted};
    font-family: ${STEEP_FONT.body};
  }
`

const BRAND_SECTIONS: ReactNode = (
  <>
    <Section
      id="logos"
      title="Logo"
      intro="Logo variants. Prefer the dark-background lockup for digital contexts; use the icon-only variant when space is constrained (favicons, social avatars)."
    >
      <FeatureGrid minCardWidth="220px">
        <LogoTile $dark>
          <img src="/ophis-lockup.svg" alt="Ophis lockup, dark variant" />
          <LogoMeta>
            <span>Primary lockup · dark background</span>
            <DownloadLink href="/ophis-lockup.svg" download>
              Download SVG ↓
            </DownloadLink>
          </LogoMeta>
        </LogoTile>
        <LogoTile>
          <img src="/ophis-wordmark.svg" alt="Ophis wordmark, light variant" />
          <LogoMeta>
            <span>Wordmark only · light background</span>
            <DownloadLink href="/ophis-wordmark.svg" download>
              Download SVG ↓
            </DownloadLink>
          </LogoMeta>
        </LogoTile>
        <LogoTile $dark>
          <img src="/ophis-icon.svg" alt="Ophis icon, dark variant" />
          <LogoMeta>
            <span>Icon · dark background</span>
            <DownloadLink href="/ophis-icon.svg" download>
              Download SVG ↓
            </DownloadLink>
          </LogoMeta>
        </LogoTile>
        <LogoTile>
          <img src="/ophis-icon-inverse.svg" alt="Ophis icon, light variant" />
          <LogoMeta>
            <span>Icon · light background</span>
            <DownloadLink href="/ophis-icon-inverse.svg" download>
              Download SVG ↓
            </DownloadLink>
          </LogoMeta>
        </LogoTile>
        <LogoTile $dark>
          <img src="/ophis-icon-sunset.svg" alt="Ophis icon, sunset gradient" />
          <LogoMeta>
            <span>Sunset accent icon</span>
            <DownloadLink href="/ophis-icon-sunset.svg" download>
              Download SVG ↓
            </DownloadLink>
          </LogoMeta>
        </LogoTile>
        <LogoTile>
          <img src="/ophis-icon-mono-dark.svg" alt="Ophis icon, monochrome" />
          <LogoMeta>
            <span>Monochrome · print-safe</span>
            <DownloadLink href="/ophis-icon-mono-dark.svg" download>
              Download SVG ↓
            </DownloadLink>
          </LogoMeta>
        </LogoTile>
        <LogoTile>
          <img src="/ophis-logo-alt.svg" alt="Ophis alternative mark" />
          <LogoMeta>
            <span>Alternative mark</span>
            <DownloadLink href="/ophis-logo-alt.svg" download>
              Download SVG ↓
            </DownloadLink>
          </LogoMeta>
        </LogoTile>
      </FeatureGrid>
    </Section>

    <Section
      id="color"
      title="Color"
      intro="The Steep editorial palette. Near-monochrome ink/paper/grays, with one warm peach accent."
    >
      <FeatureGrid minCardWidth="220px">
        <ColorSwatch $bg="#17191c" $fg="#ffffff">
          <h3>Ink</h3>
          <code>#17191C</code>
          <span>Primary text, filled buttons. The only dark surface.</span>
        </ColorSwatch>
        <ColorSwatch $bg="#ffffff" $fg="#17191c">
          <h3>Paper</h3>
          <code>#FFFFFF</code>
          <span>Page canvas and elevated surfaces.</span>
        </ColorSwatch>
        <ColorSwatch $bg="#f2f2f3" $fg="#17191c">
          <h3>Mist</h3>
          <code>#F2F2F3</code>
          <span>Card surfaces and nested content blocks.</span>
        </ColorSwatch>
        <ColorSwatch $bg="#fafafb" $fg="#17191c">
          <h3>Fog</h3>
          <code>#FAFAFB</code>
          <span>Alternating section bands and hover washes.</span>
        </ColorSwatch>
        <ColorSwatch $bg="#fbe1d1" $fg="#5d2a1a">
          <h3>Peach</h3>
          <code>#FBE1D1</code>
          <span>The single accent. Editorial highlights only, once per page.</span>
        </ColorSwatch>
        <ColorSwatch $bg="#5d2a1a" $fg="#fbe1d1">
          <h3>Sienna</h3>
          <code>#5D2A1A</code>
          <span>Ink for peach surfaces. Never body text on white.</span>
        </ColorSwatch>
      </FeatureGrid>
    </Section>

    <Section id="typography" title="Typography">
      <FeatureGrid minCardWidth="280px">
        <FontSample $family={STEEP_FONT.display}>
          <div className="sample">Aa Bb Cc</div>
          <div className="name">Georgia</div>
          <div className="role">Display, headings — regular + italic only</div>
        </FontSample>
        <FontSample $family={STEEP_FONT.body}>
          <div className="sample">Aa Bb Cc</div>
          <div className="name">Inter / system sans</div>
          <div className="role">Body, UI, paragraphs, navigation</div>
        </FontSample>
        <FontSample $family={STEEP_FONT.mono}>
          <div className="sample">Aa Bb Cc</div>
          <div className="name">System mono</div>
          <div className="role">Data, addresses, hashes, code</div>
        </FontSample>
      </FeatureGrid>
      <Callout tone="info">
        The brand typefaces are OS system stacks — Georgia, Inter with a system-ui fallback, and the system monospace
        stack. No webfont payload and no additional license is required to use them in derivative materials.
      </Callout>
    </Section>

    <Section id="usage" title="Usage guidelines">
      <Table caption="Brand asset usage do / don't">
        <Thead>
          <Tr>
            <Th>Surface</Th>
            <Th>Do</Th>
            <Th>Don&#39;t</Th>
          </Tr>
        </Thead>
        <Tbody>
          <Tr>
            <Td>Logo lockup</Td>
            <Td>Maintain ~16px clearspace on all sides.</Td>
            <Td>Stretch, skew, or apply drop-shadows.</Td>
          </Tr>
          <Tr>
            <Td>Logo color</Td>
            <Td>Use the dark-background variant on ink surfaces; light variant on paper.</Td>
            <Td>Recolor outside the palette.</Td>
          </Tr>
          <Tr>
            <Td>Favicon / social avatar</Td>
            <Td>Use the icon-only variant at sizes ≤ 64px.</Td>
            <Td>Use the wordmark below 24px height (illegible).</Td>
          </Tr>
          <Tr>
            <Td>Background</Td>
            <Td>
              For text/UI foreground, maintain WCAG AA contrast (4.5:1 for body text, 3:1 for large text). For
              decorative logos, ensure they remain visually distinct.
            </Td>
            <Td>Place the wordmark on a busy photo without backplate.</Td>
          </Tr>
          <Tr>
            <Td>Favicon</Td>
            <Td>
              Use <InlineCode>ophis-icon.svg</InlineCode> @ 32×32 / 16×16 minimum. PWA icon at 512×512 from{' '}
              <InlineCode>ophis-mark-app-icon.svg</InlineCode>.
            </Td>
            <Td>Embed the wordmark below 24px height (illegible).</Td>
          </Tr>
          <Tr>
            <Td>Social / OG image</Td>
            <Td>
              <InlineCode>ophis-og.jpg</InlineCode> @ 1200×630 (Twitter / Open Graph default). Dark backdrop with the
              lockup left-aligned.
            </Td>
            <Td>Use a portrait-orientation image (cropped on most platforms).</Td>
          </Tr>
          <Tr>
            <Td>Partner embedding</Td>
            <Td>
              On light backgrounds: use the wordmark / inverse icon variants. On dark backgrounds: use the default
              lockup / icon variants. When in doubt, reach out via <TextLink href="/contact">our contact form</TextLink>
              .
            </Td>
            <Td>Apply CSS filters (hue-rotate, invert) to recolor the logo.</Td>
          </Tr>
          <Tr>
            <Td>Print</Td>
            <Td>Use the monochrome variant; CMYK conversion handled at production.</Td>
            <Td>Submit the sunset-gradient variant for offset print (banding risk).</Td>
          </Tr>
        </Tbody>
      </Table>
    </Section>

    <Section id="meta" title="License + attribution">
      <Callout tone="info" title="Brand vs code, different terms">
        The Ophis frontend source code is open source. The Ophis brand assets (name, logos, wordmarks, color palette as
        applied) are SEPARATE from the code license and carry their own use terms below. Trademark posture is being
        formalized; until then, use of the Ophis name and marks is governed by this page and good-faith fair-use
        principles. <Badge tone="draft">draft</Badge>
      </Callout>
      <h3>Brand assets</h3>
      <p>
        Logos and wordmarks (the SVG files served from <InlineCode>/ophis-*.svg</InlineCode>) may be used:
      </p>
      <ul>
        <li>To link to or reference ophis.fi in journalism, research, partner integrations.</li>
        <li>In screenshots showing the Ophis product UI.</li>
        <li>With attribution to &quot;Ophis&quot; alongside the asset.</li>
      </ul>
      <p>They may NOT be used:</p>
      <ul>
        <li>To imply endorsement or partnership without prior written agreement.</li>
        <li>In a misleading, defamatory, or deceptive manner.</li>
        <li>To suggest the asset itself is a sponsor or principal of your work.</li>
      </ul>

      <h3>Code license</h3>
      <p>
        Ophis source code is governed by its own license (see <InlineCode>LICENSE</InlineCode> at the repository root).
        This is independent of the brand-use terms above.
      </p>
    </Section>
  </>
)

export default function BrandPage(): ReactNode {
  return (
    <PageShell
      width="wide"
      eyebrow="Brand kit"
      title="Logos, colors, type."
      lede="Drop-in assets for partners, journalists, and integrators. Brand-use terms are separate from the code license, see § License + attribution."
    >
      {BRAND_SECTIONS}
    </PageShell>
  )
}
