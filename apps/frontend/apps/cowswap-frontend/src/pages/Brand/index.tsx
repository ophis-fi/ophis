/**
 * Brand kit — logo variants + color tokens + typography spec + usage
 * guidelines.
 *
 * Phase A3 rebuild (PR #250, 2026-05-23). Replaces local
 * styled-components with ophis/ds primitives. The visual structure of
 * the prior page was actually close to right (logo grid + color cards +
 * font samples); this rewrite mostly swaps the chrome and adds usage
 * specificity.
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

import {
  Badge,
  Callout,
  FeatureCard,
  FeatureGrid,
  InlineCode,
  PageShell,
  Section,
  Table,
  Tbody,
  Td,
  TextLink,
  Th,
  Thead,
  Tr,
} from 'ophis/ds'

// Visual swatches and typography samples live in this file because they
// don't generalize to the rest of the design system — a brand-kit page
// is the one place where you DO want display-only chrome.
const LogoTile = styled.div<{ $dark?: boolean }>`
  border-radius: 12px;
  padding: 32px 18px 18px;
  background: ${({ $dark }) => ($dark ? '#02000d' : '#f5efe6')};
  border: 1px solid rgba(245, 239, 230, 0.1);
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
  color: rgba(245, 239, 230, 0.65);
  text-align: center;
`

const DownloadLink = styled.a`
  color: #f2a63e;
  font-size: 12px;
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`

const ColorSwatch = styled.div<{ $bg: string; $fg: string }>`
  border-radius: 12px;
  padding: 24px 20px;
  background: ${({ $bg }) => $bg};
  color: ${({ $fg }) => $fg};
  border: 1px solid rgba(245, 239, 230, 0.08);
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 130px;

  & h3 {
    margin: 0;
    font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
    font-size: 16px;
    font-weight: 500;
  }
  & code {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
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
  border-radius: 12px;
  padding: 24px 20px;
  background: rgba(245, 239, 230, 0.04);
  border: 1px solid rgba(245, 239, 230, 0.08);
  font-family: ${({ $family }) => $family};
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 140px;

  & .sample {
    font-size: 28px;
    line-height: 1.1;
    color: #f5efe6;
  }
  & .name {
    font-size: 13px;
    color: rgba(245, 239, 230, 0.6);
    font-family: 'Plus Jakarta Sans', system-ui;
  }
  & .role {
    font-size: 12px;
    color: rgba(242, 166, 62, 0.9);
    font-family: 'Plus Jakarta Sans', system-ui;
  }
`

export default function BrandPage(): ReactNode {
  return (
    <PageShell
      width="wide"
      eyebrow="Brand kit"
      title="Logos, colors, type."
      lede="Drop-in assets for partners, journalists, and integrators. All released under the same license as the open-source frontend (LGPL v3.0)."
    >
      <Section
        id="logos"
        title="Logo"
        intro="Six variants. Prefer the dark-background lockup for digital contexts; use the icon-only variant when space is constrained (favicons, social avatars)."
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
        </FeatureGrid>
      </Section>

      <Section id="color" title="Color">
        <FeatureGrid minCardWidth="220px">
          <ColorSwatch $bg="#02000d" $fg="#f5efe6">
            <h3>Cosmic</h3>
            <code>#02000D</code>
            <span>Background. Use full-bleed for hero surfaces.</span>
          </ColorSwatch>
          <ColorSwatch $bg="#f2a63e" $fg="#02000d">
            <h3>Sunset</h3>
            <code>#F2A63E</code>
            <span>Primary accent. Use sparingly — CTAs, emphasis, gradient anchor.</span>
          </ColorSwatch>
          <ColorSwatch $bg="#f5efe6" $fg="#02000d">
            <h3>Cream</h3>
            <code>#F5EFE6</code>
            <span>Foreground text on cosmic. Replaces stark white.</span>
          </ColorSwatch>
          <ColorSwatch
            $bg="linear-gradient(135deg, #FF8A52 0%, #FF6B5A 30%, #E55A88 65%, #A44E91 100%)"
            $fg="#0a0414"
          >
            <h3>Sunset gradient</h3>
            <code>135° · 4 stops</code>
            <span>Hero / receipt artwork only. Not for text or buttons.</span>
          </ColorSwatch>
        </FeatureGrid>
      </Section>

      <Section id="typography" title="Typography">
        <FeatureGrid minCardWidth="280px">
          <FontSample $family="'Fraunces', system-ui">
            <div className="sample">Aa Bb Cc</div>
            <div className="name">Fraunces</div>
            <div className="role">Display — headings, taglines</div>
          </FontSample>
          <FontSample $family="'Plus Jakarta Sans', system-ui">
            <div className="sample">Aa Bb Cc</div>
            <div className="name">Plus Jakarta Sans</div>
            <div className="role">Body — UI, paragraphs, navigation</div>
          </FontSample>
          <FontSample $family="'JetBrains Mono', monospace">
            <div className="sample">Aa Bb Cc</div>
            <div className="name">JetBrains Mono</div>
            <div className="role">Data — addresses, hashes, code</div>
          </FontSample>
        </FeatureGrid>
        <Callout tone="info">
          All three fonts are released under the <strong>SIL Open Font License (OFL)</strong> and
          loaded from Google Fonts at the application root. No additional license is required to
          use them in derivative materials. See <TextLink href="/legal#privacy">§ 7.4 of the Legal page</TextLink>{' '}
          for the privacy implications of Google Fonts hosting.
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
              <Td>Use the dark-background variant on cosmic surfaces; light variant on cream.</Td>
              <Td>Recolor outside the palette.</Td>
            </Tr>
            <Tr>
              <Td>Favicon / social avatar</Td>
              <Td>Use the icon-only variant at sizes ≤ 64px.</Td>
              <Td>Use the wordmark below 24px height (illegible).</Td>
            </Tr>
            <Tr>
              <Td>Background</Td>
              <Td>Ensure sufficient contrast — minimum 4.5:1 against the cosmic backdrop.</Td>
              <Td>Place the wordmark on a busy photo without backplate.</Td>
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
        <p>
          Logos and brand assets are licensed under the same{' '}
          <TextLink href="https://www.gnu.org/licenses/lgpl-3.0.html" external>
            GNU LGPL v3.0
          </TextLink>{' '}
          as the open-source frontend. Use in derivative materials is permitted with attribution.
        </p>
        <p>
          Color tokens reference Nucleus UI Lite (Gumroad, free tier) for the underlying token
          scale; brand values are Ophis-specific. See{' '}
          <InlineCode>docs/development/specs/2026-05-06-ophis-brand-foundations.md</InlineCode> for
          full design-system provenance + the rationale for the warm sunset palette over the
          typical DEX-aggregator cool-blue stack. <Badge tone="live">Live</Badge>
        </p>
      </Section>
    </PageShell>
  )
}
