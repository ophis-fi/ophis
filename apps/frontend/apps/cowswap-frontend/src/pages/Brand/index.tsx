/**
 * Ophis Brand kit — logo variants, color tokens, typography spec.
 *
 * Static single-page resource for partners, journalists, integrators. All
 * assets are static files in `public/`. Created in PR #234 closing
 * Clement's 2026-05-22 brand task #11 (Need a brandkit).
 */
import { ReactNode } from 'react'

import styled from 'styled-components/macro'

// PR #245 (2026-05-23): OphisHeader + OphisFooter come from AppContainer.

const Page = styled.main`
  width: 100%;
  display: flex;
  flex-direction: column;
  color: #f5efe6;
  font-family: 'Plus Jakarta Sans', var(--cow-font-family-primary, system-ui);
`

const Container = styled.section`
  flex: 1;
  width: min(960px, 100%);
  margin: 0 auto;
  padding: 64px 24px 96px;

  @media (max-width: 600px) {
    padding: 32px 18px 56px;
  }
`

const Title = styled.h1`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: clamp(36px, 5vw, 52px);
  margin: 0 0 8px;
  letter-spacing: -0.015em;
`

const Lede = styled.p`
  color: rgba(245, 239, 230, 0.7);
  margin: 0 0 48px;
  font-size: 16px;
  line-height: 1.6;
`

const Section = styled.section`
  margin-top: 48px;
`

const H2 = styled.h2`
  font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
  font-weight: 500;
  font-size: 24px;
  margin: 0 0 18px;
  color: #f2a63e;
`

const LogoGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
`

const LogoCard = styled.div<{ $dark?: boolean }>`
  border-radius: 12px;
  padding: 32px 18px 16px;
  background: ${({ $dark }) => ($dark ? '#02000d' : '#f5efe6')};
  border: 1px solid rgba(245, 239, 230, 0.1);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  & img {
    height: 48px;
    width: auto;
  }
`

const LogoLabel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  font-size: 13px;
  color: rgba(245, 239, 230, 0.6);
`

const DownloadLink = styled.a`
  color: #f2a63e;
  font-size: 12px;
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`

const ColorGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
`

const ColorChip = styled.div<{ $bg: string; $fg: string }>`
  border-radius: 12px;
  padding: 24px 18px;
  background: ${({ $bg }) => $bg};
  color: ${({ $fg }) => $fg};
  border: 1px solid rgba(245, 239, 230, 0.08);
  display: flex;
  flex-direction: column;
  gap: 6px;
  & h3 {
    margin: 0;
    font-family: 'Fraunces', var(--cow-font-family-primary, system-ui);
    font-size: 16px;
    font-weight: 500;
  }
  & code {
    font-family: 'JetBrains Mono', var(--cow-font-family-mono, monospace);
    font-size: 13px;
    opacity: 0.85;
  }
  & span {
    font-size: 12px;
    opacity: 0.75;
  }
`

const FontGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
`

const FontCard = styled.div<{ $family: string }>`
  border-radius: 12px;
  padding: 24px 20px;
  background: rgba(245, 239, 230, 0.04);
  border: 1px solid rgba(245, 239, 230, 0.08);
  font-family: ${({ $family }) => $family};
  display: flex;
  flex-direction: column;
  gap: 8px;
  & .sample {
    font-size: 28px;
    line-height: 1.1;
  }
  & .name {
    font-size: 13px;
    color: rgba(245, 239, 230, 0.55);
  }
  & .role {
    font-size: 12px;
    color: rgba(242, 166, 62, 0.9);
  }
`

const Note = styled.p`
  margin: 24px 0 0;
  color: rgba(245, 239, 230, 0.5);
  font-size: 13px;
  line-height: 1.6;
`

export default function BrandPage(): ReactNode {
  return (
    <Page>
      <Container>
        <Title>Brand kit</Title>
        <Lede>
          Logo variants, color tokens, and typography for partners and journalists. All assets
          released under the same license as the open-source frontend.
        </Lede>

        <Section>
          <H2>Logo</H2>
          <LogoGrid>
            <LogoCard $dark>
              <img src="/ophis-lockup.svg" alt="Ophis lockup" />
              <LogoLabel>
                <span>Primary lockup, dark background</span>
                <DownloadLink href="/ophis-lockup.svg" download>
                  Download SVG ↓
                </DownloadLink>
              </LogoLabel>
            </LogoCard>
            <LogoCard>
              <img src="/ophis-wordmark.svg" alt="Ophis wordmark" />
              <LogoLabel>
                <span>Wordmark only, light background</span>
                <DownloadLink href="/ophis-wordmark.svg" download>
                  Download SVG ↓
                </DownloadLink>
              </LogoLabel>
            </LogoCard>
            <LogoCard $dark>
              <img src="/ophis-icon.svg" alt="Ophis icon" />
              <LogoLabel>
                <span>Icon, dark background</span>
                <DownloadLink href="/ophis-icon.svg" download>
                  Download SVG ↓
                </DownloadLink>
              </LogoLabel>
            </LogoCard>
            <LogoCard>
              <img src="/ophis-icon-inverse.svg" alt="Ophis icon inverse" />
              <LogoLabel>
                <span>Icon, light background</span>
                <DownloadLink href="/ophis-icon-inverse.svg" download>
                  Download SVG ↓
                </DownloadLink>
              </LogoLabel>
            </LogoCard>
            <LogoCard $dark>
              <img src="/ophis-icon-sunset.svg" alt="Ophis icon sunset" />
              <LogoLabel>
                <span>Sunset accent icon</span>
                <DownloadLink href="/ophis-icon-sunset.svg" download>
                  Download SVG ↓
                </DownloadLink>
              </LogoLabel>
            </LogoCard>
            <LogoCard>
              <img src="/ophis-icon-mono-dark.svg" alt="Ophis icon monochrome" />
              <LogoLabel>
                <span>Monochrome (print-safe)</span>
                <DownloadLink href="/ophis-icon-mono-dark.svg" download>
                  Download SVG ↓
                </DownloadLink>
              </LogoLabel>
            </LogoCard>
          </LogoGrid>
        </Section>

        <Section>
          <H2>Color</H2>
          <ColorGrid>
            <ColorChip $bg="#02000d" $fg="#f5efe6">
              <h3>Cosmic</h3>
              <code>#02000D</code>
              <span>Background. Use full-bleed for hero surfaces.</span>
            </ColorChip>
            <ColorChip $bg="#f2a63e" $fg="#02000d">
              <h3>Sunset</h3>
              <code>#F2A63E</code>
              <span>Primary accent. Use sparingly — CTAs, emphasis, gradients.</span>
            </ColorChip>
            <ColorChip $bg="#f5efe6" $fg="#02000d">
              <h3>Cream</h3>
              <code>#F5EFE6</code>
              <span>Foreground text on cosmic. Replaces stark white.</span>
            </ColorChip>
            <ColorChip
              $bg="linear-gradient(135deg, #F2A63E 0%, #D960B5 60%, #4F1DCA 100%)"
              $fg="#0a0414"
            >
              <h3>Sunset gradient</h3>
              <code>135° · 3 stops</code>
              <span>Primary CTA fill only. Don&#39;t use for text or backgrounds.</span>
            </ColorChip>
          </ColorGrid>
        </Section>

        <Section>
          <H2>Typography</H2>
          <FontGrid>
            <FontCard $family="'Fraunces', system-ui">
              <div className="sample">Aa Bb Cc</div>
              <div className="name">Fraunces</div>
              <div className="role">Display — headings, taglines</div>
            </FontCard>
            <FontCard $family="'Plus Jakarta Sans', system-ui">
              <div className="sample">Aa Bb Cc</div>
              <div className="name">Plus Jakarta Sans</div>
              <div className="role">Body — UI, paragraphs, navigation</div>
            </FontCard>
            <FontCard $family="'JetBrains Mono', monospace">
              <div className="sample">Aa Bb Cc</div>
              <div className="name">JetBrains Mono</div>
              <div className="role">Data — addresses, hashes, code</div>
            </FontCard>
          </FontGrid>
          <Note>
            All three fonts are released under the SIL Open Font License (OFL) and are loaded from
            Google Fonts via the application root. No additional license is required to use them in
            derivative materials.
          </Note>
        </Section>

        <Section>
          <H2>Usage guidelines</H2>
          <Note>
            <strong>Don&#39;t</strong>: stretch the logo, recolor outside the palette above, or
            place the wordmark on a busy background without sufficient contrast.{' '}
            <strong>Do</strong>: maintain ~16px clearspace around the lockup, prefer the dark-
            background variant for digital contexts, and use the icon-only variant when space is
            constrained (favicons, social avatars).
          </Note>
        </Section>
      </Container>
    </Page>
  )
}
