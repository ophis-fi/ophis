import type { ReactNode } from 'react'

import { useParams } from 'react-router'
import styled from 'styled-components/macro'

import { useOphisDiscovery } from './useOphisDiscovery'

import type { OphisDiscoverySnapshot } from './ophisDiscovery.types'

const Panel = styled.aside`
  width: 300px;
  flex: none;
  align-self: flex-start;
  padding: 16px 14px 12px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.028);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(16px);
  box-shadow:
    0 24px 70px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  color: inherit;
`

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const Title = styled.h2`
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
`

const Chip = styled.span`
  margin-left: auto;
  padding: 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  font-size: 9px;
  letter-spacing: 0.5px;
  opacity: 0.62;
`

const Context = styled.p`
  margin: 7px 0 5px;
  font-size: 10.5px;
  line-height: 1.4;
  opacity: 0.5;
`

const List = styled.div`
  display: flex;
  flex-direction: column;
`

const Row = styled.div`
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 45px;
  padding: 7px 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);

  &:last-child {
    border-bottom: none;
  }
`

const Monogram = styled.span`
  display: inline-flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(135deg, #6c5ce7, #3a8bff);
  color: rgba(255, 255, 255, 0.92);
  font-size: 9px;
  font-weight: 700;
`

const Identity = styled.span`
  min-width: 0;
`

const Symbol = styled.strong`
  display: block;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Name = styled.span`
  display: block;
  overflow: hidden;
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.2;
  opacity: 0.48;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const AddressText = styled.code`
  font-family: inherit;
  font-size: 9px;
  opacity: 0.42;
`

const Footer = styled.div`
  margin: 8px 5px 1px;
  font-size: 9.5px;
  line-height: 1.45;
  opacity: 0.48;
`

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function monogram(symbol: string): string {
  return Array.from(symbol).slice(0, 2).join('').toUpperCase()
}

export interface OphisDiscoveryPanelViewProps {
  snapshot: OphisDiscoverySnapshot
}

export function OphisDiscoveryPanelView({ snapshot }: OphisDiscoveryPanelViewProps): ReactNode {
  return (
    <Panel aria-labelledby="ophis-discovery-title">
      <Header>
        <Title id="ophis-discovery-title">Ophis Discovery</Title>
        <Chip>DISPLAY ONLY</Chip>
      </Header>
      <Context>
        Community-ranked ERC-20 metadata on {snapshot.chainLabel}, pinned to block{' '}
        {snapshot.blockNumber.toLocaleString('en-US')}.
      </Context>
      <List role="list" aria-label="Discovered token contracts">
        {snapshot.tokens.map((token) => (
          <Row role="listitem" key={`${token.chainId}:${token.address}`}>
            <Monogram aria-hidden>{monogram(token.symbol)}</Monogram>
            <Identity>
              <Symbol>{token.symbol}</Symbol>
              <Name>{token.name}</Name>
            </Identity>
            <AddressText title={token.address}>{shortenAddress(token.address)}</AddressText>
          </Row>
        ))}
      </List>
      <Footer>
        Independent discovery data is not an Ophis endorsement, route, token-list activation, or compatibility decision.
      </Footer>
    </Panel>
  )
}

export function OphisDiscoveryPanel(): ReactNode {
  const params = useParams()
  const routeChainId = Number(params.chainId)
  const state = useOphisDiscovery(true, Number.isInteger(routeChainId) ? routeChainId : undefined)

  if (state.status !== 'ready' || state.snapshot.tokens.length === 0) return null
  return <OphisDiscoveryPanelView snapshot={state.snapshot} />
}
