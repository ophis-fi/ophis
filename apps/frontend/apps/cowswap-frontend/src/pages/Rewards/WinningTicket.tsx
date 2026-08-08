import { ReactNode } from 'react'

import { ConnectWalletCta } from 'pages/Affiliate/ConnectWalletCta'

import { ClaimActionButton } from './Rewards.styled'
import { useTradeReward } from './useTradeReward'
import * as styledEl from './WinningTicket.styled'

export interface WinningTicketProps {
  account: string | undefined
}

export function WinningTicket({ account }: WinningTicketProps): ReactNode {
  const { status, loading, claiming, error, claim } = useTradeReward(account)

  if (!account) {
    return (
      <styledEl.TicketEmpty>
        <h3>Your winning ticket appears here</h3>
        <p>Connect the wallet used for your qualifying Ophis swap.</p>
        <ConnectWalletCta />
      </styledEl.TicketEmpty>
    )
  }

  if (loading)
    return (
      <styledEl.TicketEmpty>
        <p>Checking this wallet...</p>
      </styledEl.TicketEmpty>
    )

  if (!status?.eligible || status.ticketId === undefined || status.amountUsdg === undefined) {
    return (
      <styledEl.TicketEmpty>
        <h3>No ticket yet</h3>
        <p>
          The campaign is live. Make a verified, settled Ophis swap of at least $100 to receive one winning ticket per
          wallet while rewards remain.
        </p>
        {error && <styledEl.TicketError>{error}</styledEl.TicketError>}
      </styledEl.TicketEmpty>
    )
  }

  const assigned = status.assignmentStatus === 'confirmed'
  const claimed = status.claimStatus === 'claimed'

  return (
    <styledEl.WinningTicket>
      <styledEl.TicketTopline>
        <span>OPHIS TRADE REWARD</span>
        <span>#{String(status.ticketId).padStart(4, '0')}</span>
      </styledEl.TicketTopline>
      <styledEl.TicketPrize>
        <small>YOU WON</small>
        <strong>${status.amountUsdg}</strong>
        <span>USDG · ROBINHOOD CHAIN</span>
      </styledEl.TicketPrize>
      <styledEl.TicketFooter>
        {claimed ? (
          <styledEl.TicketClaimed>Reward claimed</styledEl.TicketClaimed>
        ) : assigned ? (
          <ClaimActionButton type="button" onClick={claim} disabled={claiming}>
            {claiming ? 'Claiming...' : `Claim $${status.amountUsdg} USDG`}
          </ClaimActionButton>
        ) : (
          <span>Your reward is being secured on Robinhood Chain.</span>
        )}
        <small>Ophis sponsors the claim transaction. Your wallet receives the USDG.</small>
        {error && <styledEl.TicketError>{error}</styledEl.TicketError>}
      </styledEl.TicketFooter>
    </styledEl.WinningTicket>
  )
}
