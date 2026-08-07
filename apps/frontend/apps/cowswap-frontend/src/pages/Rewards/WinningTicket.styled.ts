import styled from 'styled-components/macro'

export const WinningTicket = styled.article`
  position: relative;
  max-width: 620px;
  overflow: hidden;
  border: 1px solid rgba(242, 166, 62, 0.55);
  border-radius: 18px;
  background:
    radial-gradient(circle at 50% 0%, rgba(242, 166, 62, 0.18), transparent 52%),
    linear-gradient(145deg, rgba(38, 26, 17, 0.98), rgba(17, 15, 20, 0.98));
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.3);

  &::before,
  &::after {
    content: '';
    position: absolute;
    top: 50%;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--cow-color-background, #080808);
    border: 1px solid rgba(242, 166, 62, 0.45);
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
  border-bottom: 1px dashed rgba(242, 166, 62, 0.35);
  font-family: 'Geist Mono', ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
  color: #ffc477;
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
    opacity: 0.65;
  }
  > strong {
    font-size: clamp(64px, 12vw, 104px);
    line-height: 1;
    color: #fff4e5;
  }
  > span {
    margin-top: 8px;
    font-size: 12px;
    letter-spacing: 0.1em;
    color: #ffc477;
  }
`

export const TicketFooter = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 18px 24px 22px;
  border-top: 1px dashed rgba(242, 166, 62, 0.35);
  text-align: center;

  > small {
    max-width: 430px;
    font-size: 11px;
    opacity: 0.58;
  }
`

export const TicketClaimed = styled.strong`
  color: #71dca8;
`

export const TicketEmpty = styled.div`
  max-width: 620px;
  padding: 24px;
  border: 1px dashed rgba(245, 239, 230, 0.2);
  border-radius: 18px;
  background: rgba(245, 239, 230, 0.025);

  > h3,
  > p {
    margin: 0 0 10px;
  }
`

export const TicketError = styled.p`
  margin: 0;
  color: #ff9d8f;
  font-size: 12px;
`
