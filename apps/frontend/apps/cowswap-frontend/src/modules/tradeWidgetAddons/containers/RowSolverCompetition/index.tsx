import { ReactNode } from 'react'

import { HoverTooltip, RowFixed } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Trans } from '@lingui/react/macro'

import { useSolversInfo } from 'common/hooks/useSolversInfo'

import { StyledInfoIcon, StyledRowBetween, TextWrapper, TransactionText } from '../../pure/Row/styled'

/**
 * "Up to N solvers" row for the expanded fee accordion (ux-quoting decision
 * 60). N comes from the merged solver info (CMS entries plus the static
 * registry for Ophis-operated chains, see `ophis/solvers.ts`); listing does
 * not guarantee a bid on every auction, hence "up to". Hidden when no solver
 * is known for the chain.
 */
export function RowSolverCompetition(): ReactNode {
  const { chainId } = useWalletInfo()
  const solversInfo = useSolversInfo(chainId)
  const totalSolvers = Object.keys(solversInfo).length

  if (totalSolvers === 0) return null

  return (
    <StyledRowBetween>
      <RowFixed>
        <TextWrapper>
          <TransactionText>
            <Trans>Solver competition</Trans>
          </TransactionText>
        </TextWrapper>
        <HoverTooltip
          wrapInContainer
          content={
            <Trans>
              Your order goes into a batch auction where up to {totalSolvers} independent solvers compete to give you
              the best execution. The winning solver must at least match the minimum you signed; any improvement is
              returned to you as surplus.
            </Trans>
          }
        >
          <StyledInfoIcon size={16} />
        </HoverTooltip>
      </RowFixed>
      <TextWrapper textAlign="right">
        <span>{totalSolvers === 1 ? <Trans>1 solver</Trans> : <Trans>up to {totalSolvers} solvers</Trans>}</span>
      </TextWrapper>
    </StyledRowBetween>
  )
}
