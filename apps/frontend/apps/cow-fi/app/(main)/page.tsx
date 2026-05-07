'use client'

import { useCowAnalytics } from '@cowprotocol/analytics'

import { CowFiCategory } from 'src/common/analytics/types'

import { Link, LinkType } from '@/components/Link'
import { CONFIG } from '@/const/meta'
import {
  ContainerCard,
  ContainerCardSection,
  HeroBackground,
  HeroContainer,
  HeroContent,
  HeroSubtitle,
  HeroTitle,
  PageWrapper,
  SectionTitleDescription,
  SectionTitleText,
  SectionTitleWrapper,
  TopicCard,
  TopicDescription,
  TopicList,
  TopicTitle,
} from '@/styles/styled'

const FEATURES = [
  {
    title: 'DCA & TWAP',
    description:
      'Split a trade across time. Every leaf is a real order — solvers compete on each one, MEV-protected by construction.',
    bgColor: '#FFF3EE',
    textColor: '#2A0B07',
    descriptionColor: '#53575A',
  },
  {
    title: 'MEV-proof receipts',
    description:
      'Every settled order produces a downloadable proof — solver competition, executed price, surplus returned. Auditable trade history without trusting us.',
    bgColor: '#E66A55',
    textColor: '#FFF3EE',
    descriptionColor: '#FFDFD3',
  },
  {
    title: 'Treasury-ready',
    description:
      'Ophis as a Safe app. DAOs sign batched approvals, route on-chain via the same intent system, export CSV for accounting.',
    bgColor: '#2F3133',
    textColor: '#FFF3EE',
    descriptionColor: '#C1C4C6',
  },
]

export default function Page() {
  const cowAnalytics = useCowAnalytics()

  const sendHomeEvent = (action: string) => {
    cowAnalytics.sendEvent({
      category: CowFiCategory.HOME,
      action,
    })
  }

  return (
    <PageWrapper>
      <HeroContainer minHeight="640px" maxWidth={'100%'} margin="-76px auto -48px" padding="160px 20px 72px">
        <HeroBackground
          style={{
            background:
              'radial-gradient(120% 100% at 20% 30%, #FF8A52 0%, #E66A55 40%, #C73D6C 75%, #5C1D14 100%)',
          }}
        />
        <HeroContent flex={'0 1 0'}>
          <HeroTitle fontSize={148} fontSizeMobile={80} style={{ color: '#FFF3EE' }}>
            Ophis returns surplus.
          </HeroTitle>
          <HeroSubtitle color="#FFF3EE" style={{ opacity: 0.92, maxWidth: 720, fontSize: 20 }}>
            Intent-based DEX aggregator. DCA, TWAP, and MEV-protected swaps for power-user retail and DAO treasuries.
          </HeroSubtitle>
          <Link
            external
            linkType={LinkType.HeroButton}
            href={CONFIG.url.swap}
            onClick={() => sendHomeEvent('click-hero-trade')}
          >
            Start swapping
          </Link>
        </HeroContent>
      </HeroContainer>

      <ContainerCard bgColor={'#FFF3EE'}>
        <ContainerCardSection>
          <SectionTitleWrapper maxWidth={900}>
            <SectionTitleText>Three reasons</SectionTitleText>
            <SectionTitleDescription>
              Every order signed on Ophis is a single intent. Solvers compete in batch auctions, the winner settles your
              trade, and any price improvement over your quote comes back to you. There&apos;s no public mempool, no
              sandwich risk, and no opportunity for the operator to silently capture surplus.
            </SectionTitleDescription>
          </SectionTitleWrapper>

          <TopicList columns={3} columnsTablet={2}>
            {FEATURES.map((f, i) => (
              <TopicCard key={i} bgColor={f.bgColor} textColor={f.textColor}>
                <TopicTitle fontSize={32}>{f.title}</TopicTitle>
                <TopicDescription color={f.descriptionColor}>{f.description}</TopicDescription>
              </TopicCard>
            ))}
          </TopicList>
        </ContainerCardSection>
      </ContainerCard>

      <ContainerCard bgColor={'#2A0B07'} color={'#FFF3EE'} touchFooter>
        <ContainerCardSection>
          <SectionTitleWrapper maxWidth={900}>
            <SectionTitleText textAlign="center">Built on CoW Protocol</SectionTitleText>
            <SectionTitleDescription color={'#FFDFD3'} textAlign="center">
              Ophis is a self-hosted intent broker that routes orders into CoW Protocol&apos;s solver network.
              Settlement is on-chain via audited GPv2Settlement contracts; we don&apos;t custody, we don&apos;t fork
              consensus, we don&apos;t run our own solvers. The plumbing is theirs. The product is ours.
            </SectionTitleDescription>
            <Link
              external
              linkType={LinkType.SectionTitleButton}
              href="https://docs.cow.fi"
              onClick={() => sendHomeEvent('click-cow-protocol-docs')}
            >
              CoW Protocol docs
            </Link>
          </SectionTitleWrapper>
        </ContainerCardSection>
      </ContainerCard>
    </PageWrapper>
  )
}
