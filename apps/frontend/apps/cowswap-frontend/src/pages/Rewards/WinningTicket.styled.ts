import styled from 'styled-components/macro'

export const WinningTicket = styled.article`
  position: relative;
  max-width: 620px;
  overflow: hidden;
  border: 1px solid #dbb8a0;
  border-radius: 18px;
  background: #fbe1d1;
  color: #5d2a1a;
  box-shadow: 0 12px 32px rgba(23, 25, 28, 0.06);

  &::before,
  &::after {
    content: '';
    position: absolute;
    top: 50%;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--cow-color-background, #080808);
    border: 1px solid #dbb8a0;
    transform: translateY(-50%);
  }
  &::before {
    left: -13px;
  }
  &::after {
    right: -13px;
  }
`

export const TicketTopline = styled.div`
  display: flex;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px dashed #dbb8a0;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  color: #5d2a1a;
`

export const TicketPrize = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 30px 24px 24px;
  text-align: center;

  > small {
    font-size: 11px;
    letter-spacing: 0.16em;
    opacity: 1;
  }
  > strong {
    font-size: clamp(64px, 12vw, 104px);
    line-height: 1;
    color: #5d2a1a;
  }
  > span {
    margin-top: 8px;
    font-size: 12px;
    letter-spacing: 0.1em;
    color: #5d2a1a;
  }
`

export const TicketFooter = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 18px 24px 22px;
  border-top: 1px dashed #dbb8a0;
  text-align: center;

  > small {
    max-width: 430px;
    font-size: 11px;
    opacity: 1;
  }
`

export const TicketClaimed = styled.strong`
  color: #217346;
`

export const TicketEmpty = styled.div`
  max-width: 620px;
  padding: 24px;
  border: 1px dashed var(--cow-color-border);
  border-radius: 18px;
  background: var(--cow-color-paper);

  > h3,
  > p {
    margin: 0 0 10px;
  }
`

export const TicketError = styled.p`
  margin: 0;
  color: var(--cow-color-danger-text);
  font-size: 12px;
`
