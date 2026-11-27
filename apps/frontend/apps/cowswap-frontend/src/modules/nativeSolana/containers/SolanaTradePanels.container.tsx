import { useAtom, useAtomValue } from 'jotai'
import { type MouseEventHandler, ReactNode, useState } from 'react'

import { Trans, useLingui } from '@lingui/react/macro'
import { formatOphisSolanaAmount, requestOphisLocalTestSol, solanaAddress } from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'
import { useAssetVerification, VerifiedAssetBadge } from 'entities/verifiedAsset'
import { ChevronDown } from 'react-feather'

import { SellAmountPresets } from 'common/pure/CurrencyInputPanel/SellAmountPresets.pure'

import { AssetIcon } from '../pure/AssetPicker.pure'
import * as styledEl from '../pure/SwapForm.styled'
import { balanceEndpoint, nativeAsset, solanaAssetIdentity, unknownAsset } from '../services/assets.service'
import { minimumSolanaBuyAmount } from '../services/trade.service'
import {
  orderSolReserveAtom,
  solanaHoldingsAtom,
  solanaNetworkAssetsAtom,
  sellAmountStateAtom,
  walletAssetListAtom,
  walletHoldingsMapAtom,
} from '../state/assets.atoms'
import { nativeSolanaBusyAtom, nativeSolanaFormAtom, nativeSolanaReviewAtom } from '../state/trade.atoms'

export function SellPanel({ open }: { open: MouseEventHandler<HTMLButtonElement> }): ReactNode {
  const { t } = useLingui()
  const [form, setForm] = useAtom(nativeSolanaFormAtom)
  const busy = useAtomValue(nativeSolanaBusyAtom)
  const owner = useAtomValue(solanaConnectionAtom)
  const balances = useAtomValue(solanaHoldingsAtom)
  const reserveQuery = useAtomValue(orderSolReserveAtom)
  const assets = useAtomValue(walletAssetListAtom)
  const sell = assets.find((asset) => asset.mint === form.sellMint) ?? unknownAsset(form.sellMint)
  const verification = useAssetVerification(solanaAssetIdentity(sell))
  const symbol = sell.symbol
  const { balanceKnown, balance, exceeds, needsSolForFees, solShortfall, spendable, precision, reserve } =
    useAtomValue(sellAmountStateAtom)
  const missingSol = solShortfall === undefined ? undefined : formatOphisSolanaAmount(solShortfall, 9)
  const reservedSol = reserve === undefined ? undefined : formatOphisSolanaAmount(reserve, 9)
  return (
    <styledEl.Panel>
      <styledEl.Caption>
        <Trans>You sell</Trans>
      </styledEl.Caption>
      <styledEl.Line>
        <styledEl.Amount
          className="token-amount-input"
          aria-label="Amount to sell"
          placeholder={t`Enter amount`}
          inputMode="decimal"
          value={form.amount}
          disabled={busy}
          onChange={(event) => setForm({ ...form, amount: event.target.value })}
        />
        <styledEl.TokenButton type="button" aria-label={'Sell token: ' + sell.symbol} disabled={busy} onClick={open}>
          <AssetIcon asset={sell} />
          {sell.symbol}
          <VerifiedAssetBadge verified={verification} /> <ChevronDown size={16} aria-hidden="true" />
        </styledEl.TokenButton>
      </styledEl.Line>
      <SellAmountPresets
        spendable={owner && !busy && precision !== undefined ? spendable : undefined}
        onSelect={(atoms) => {
          if (precision !== undefined) setForm({ ...form, amount: formatOphisSolanaAmount(atoms, precision) })
        }}
      />
      {owner && form.sellMint === 'SOL' && (
        <styledEl.Helper>
          {!form.buyMint ? (
            <Trans>Choose a receive token to calculate fees and rent.</Trans>
          ) : reservedSol !== undefined ? (
            <Trans>Estimated fees and rent reserved · {reservedSol} SOL</Trans>
          ) : (
            <Trans>Amount shortcuts need a fee and rent estimate.</Trans>
          )}
        </styledEl.Helper>
      )}
      <styledEl.Helper aria-live="polite">
        <span>
          {owner ? (
            balanceKnown ? (
              <Trans>
                Wallet balance · {balance} {symbol}
              </Trans>
            ) : balances.isFetching ? (
              <Trans>Loading wallet balances…</Trans>
            ) : (
              <Trans>Wallet balances unavailable</Trans>
            )
          ) : (
            <Trans>Connect to see your wallet balance.</Trans>
          )}
        </span>
        {owner && (
          <styledEl.SmallButton
            type="button"
            disabled={busy || balances.isFetching || reserveQuery.isFetching}
            onClick={() => {
              void balances.refetch()
              if (reserveQuery.isEnabled) void reserveQuery.refetch()
            }}
          >
            <Trans>Refresh balance</Trans>
          </styledEl.SmallButton>
        )}
      </styledEl.Helper>
      {exceeds && (
        <styledEl.Helper role="alert">
          <Trans>Amount exceeds your wallet balance.</Trans>
        </styledEl.Helper>
      )}
      {solShortfall !== undefined && (
        <styledEl.Helper role="alert">
          <Trans>Add {missingSol} more SOL for fees and deposits.</Trans>
        </styledEl.Helper>
      )}
      {needsSolForFees && (
        <styledEl.Helper role="alert">
          <Trans>Leave some SOL in your wallet for network fees and account rent.</Trans>
        </styledEl.Helper>
      )}
    </styledEl.Panel>
  )
}
export function BuyPanel({ open }: { open: MouseEventHandler<HTMLButtonElement> }): ReactNode {
  const [form, setForm] = useAtom(nativeSolanaFormAtom)
  const busy = useAtomValue(nativeSolanaBusyAtom)
  const review = useAtomValue(nativeSolanaReviewAtom)
  const assets = useAtomValue(walletAssetListAtom)
  const network = useAtomValue(solanaNetworkAssetsAtom).data ?? [nativeAsset]
  const buy = assets.find((asset) => asset.mint === form.buyMint) ?? (form.buyMint ? unknownAsset(form.buyMint) : null)
  const verification = useAssetVerification(solanaAssetIdentity(buy))
  return (
    <styledEl.Panel>
      <styledEl.Caption>
        <Trans>You receive</Trans>
      </styledEl.Caption>
      <styledEl.Line>
        <styledEl.AmountText>
          {review ? formatOphisSolanaAmount(BigInt(review.quote.quote.buyAmount), review.buy.decimals) : '—'}
        </styledEl.AmountText>
        <styledEl.TokenButton
          type="button"
          aria-label={'Buy token: ' + (buy?.symbol ?? 'Select token')}
          disabled={busy}
          onClick={open}
        >
          {buy && <AssetIcon asset={buy} />} {buy?.symbol ?? <Trans>Select token</Trans>}{' '}
          <VerifiedAssetBadge verified={verification} /> <ChevronDown size={16} aria-hidden="true" />
        </styledEl.TokenButton>
      </styledEl.Line>
      {review && (
        <styledEl.Helper>
          <Trans>Minimum received</Trans> ·{' '}
          {formatOphisSolanaAmount(minimumSolanaBuyAmount(review), review.buy.decimals)} {buy?.symbol}
        </styledEl.Helper>
      )}
      <styledEl.Helper>
        {network
          .slice(0, 4)
          .filter((asset) => asset.mint !== form.sellMint && asset.mint !== buy?.mint)
          .map((asset) => (
            <styledEl.SmallButton
              key={asset.mint}
              type="button"
              title={asset.name}
              disabled={busy}
              onClick={() => setForm({ ...form, buyMint: asset.mint })}
            >
              {asset.symbol}
            </styledEl.SmallButton>
          ))}
      </styledEl.Helper>
    </styledEl.Panel>
  )
}
export function LocalTestFunds(): ReactNode {
  const config = OPHIS_SOLANA_CONFIG
  const test = config?.chain === 'solana:localnet' && !!balanceEndpoint(config)
  const owner = useAtomValue(solanaConnectionAtom)?.account.address
  const balances = useAtomValue(solanaHoldingsAtom)
  const holdings = useAtomValue(walletHoldingsMapAtom)
  const noSol = (holdings.get('SOL')?.atoms ?? 0n) === 0n
  const [funding, setFunding] = useState(false)
  const [fundingError, setFundingError] = useState('')
  async function fund(): Promise<void> {
    if (!test || !config || !owner || funding) return
    setFunding(true)
    setFundingError('')
    try {
      await requestOphisLocalTestSol(config.genesis, solanaAddress(owner))
      await balances.refetch()
    } catch (error) {
      setFundingError(error instanceof Error ? error.message : 'Test SOL request failed.')
    } finally {
      setFunding(false)
    }
  }
  return (
    <>
      {' '}
      {test && owner && balances.data && !balances.isError && (
        <styledEl.Helper>
          {noSol && <Trans>This wallet needs test SOL on localnet.</Trans>}
          <styledEl.SmallButton type="button" onClick={() => void fund()} disabled={funding}>
            {funding ? <Trans>Requesting test SOL…</Trans> : <Trans>Get 0.1 test SOL</Trans>}
          </styledEl.SmallButton>
        </styledEl.Helper>
      )}
      {fundingError && <p role="alert">{fundingError}</p>}
    </>
  )
}
