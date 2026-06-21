import { useState, type ChangeEvent } from 'react';
import type SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { getQuote } from '../lib/quote';
import { buildAppData } from '../lib/appData';
import { assembleOrder } from '../lib/order';
import { submitOrder } from '../lib/submit';
import { resolveReferralCode } from '../lib/referral';
import { getWethAddress } from '../lib/weth';
import { isNativeEth } from '../lib/tokens';
import { OrderStatus } from './OrderStatus';

interface Props {
  sdk: SafeAppsSDK;
  owner: string;
  chainId: number;
}

const shell = { fontFamily: 'system-ui', padding: 24, maxWidth: 520, display: 'grid', gap: 12 } as const;

// Scaffold-level form: raw token addresses + atom amounts. Replace with a real token picker
// + balance reads + decimals handling before production.
export function SwapForm({ sdk, owner, chainId }: Props) {
  const [sellToken, setSellToken] = useState('');
  const [buyToken, setBuyToken] = useState('');
  const [sellAmount, setSellAmount] = useState('');
  // Sell native ETH: wrap it to WETH in the same Safe execution (submit.ts) and sell WETH, so the
  // order owner stays the Safe and the rebate attributes (eth-flow would lose it). See weth.ts.
  const [sellNative, setSellNative] = useState(false);
  // The quote is stored together with the EXACT appData it was priced against, so onPropose
  // submits the same fee-bearing appData the quote reflected (never a fresh/divergent one).
  // `wrapNative` is captured WITH the quote so the proposal wraps iff the quote was taken in WETH.
  const [quoted, setQuoted] = useState<{
    quote: any;
    fullAppData: string;
    appDataHash: string;
    wrapNative: boolean;
  } | null>(null);
  const [submitted, setSubmitted] = useState<{
    orderUid: string;
    safeTxHash: string;
    enrollmentWarning?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const referral = resolveReferralCode();

  // Editing any input invalidates a fetched quote: clear it so the proposal button (gated on
  // `quoted`) disappears and the Safe tx can never be built from inputs other than those shown.
  function onInput(setter: (v: string) => void) {
    return (e: ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      setQuoted(null);
      setError(null);
    };
  }

  async function onQuote() {
    setError(null); setBusy(true); setQuoted(null);
    try {
      const ownerAddr = owner as `0x${string}`;
      // Build the fee-bearing appData FIRST, then quote with it so the quoted amounts reflect the
      // Ophis partner fee. appData is deterministic in (chainId, owner, referral).
      const { fullAppData, appDataHash } = await buildAppData(chainId, ownerAddr, referral);
      // Selling native ETH — via the checkbox OR the native sentinel typed/pasted into the sell
      // field? Quote in WETH; the Safe wraps its ETH to WETH in the same execution (submit.ts), so
      // the order sells WETH (owner = Safe -> the rebate attributes normally).
      const wrapNative = sellNative || isNativeEth(sellToken);
      const sellTokenForQuote = wrapNative ? getWethAddress(chainId) : sellToken;
      const quote = await getQuote(chainId, owner, sellTokenForQuote, buyToken, sellAmount, fullAppData, appDataHash);
      setQuoted({ quote, fullAppData, appDataHash, wrapNative });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function onPropose() {
    if (!quoted) return;
    setError(null); setBusy(true);
    try {
      const ownerAddr = owner as `0x${string}`;
      const { quote, fullAppData, appDataHash } = quoted;
      const order = assembleOrder(ownerAddr, quote, appDataHash);
      setSubmitted(await submitOrder(sdk, chainId, ownerAddr, order, fullAppData, appDataHash, quoted.wrapNative));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (submitted) {
    return (
      <OrderStatus
        chainId={chainId}
        orderUid={submitted.orderUid}
        safeTxHash={submitted.safeTxHash}
        enrollmentWarning={submitted.enrollmentWarning}
      />
    );
  }

  const q = quoted ? (quoted.quote?.quote ?? quoted.quote) : null;
  return (
    <main style={shell}>
      <h1>Ophis Swap</h1>
      <p style={{ color: '#666', marginTop: -8 }}>
        Chain {chainId} · Safe {short(owner)}{referral ? ` · ref ${referral}` : ''}
      </p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={sellNative}
          onChange={(e) => { setSellNative(e.target.checked); setQuoted(null); setError(null); }}
          style={{ width: 'auto' }}
        />
        Sell native ETH (wraps to WETH in the same Safe tx)
      </label>
      <label>Sell token (address)
        <input
          value={sellNative ? 'native ETH → WETH' : sellToken}
          onChange={onInput(setSellToken)}
          placeholder="0x..."
          disabled={sellNative}
        />
      </label>
      <label>Buy token (address)
        <input value={buyToken} onChange={onInput(setBuyToken)} placeholder="0x..." />
      </label>
      <label>Sell amount (atoms)
        <input value={sellAmount} onChange={onInput(setSellAmount)} placeholder="1000000000000000000" />
      </label>
      <button onClick={onQuote} disabled={busy || (!sellNative && !sellToken) || !buyToken || !sellAmount}>Get quote</button>
      {q && (
        <div style={{ background: '#f6f6f7', padding: 12, borderRadius: 8, display: 'grid', gap: 4 }}>
          <div>Buy amount (quoted, after fee): {q.buyAmount}</div>
          <div>Fee: {q.feeAmount ?? '0'}</div>
          <div style={{ color: '#666' }}>Quoted with the Ophis partner fee + your referral in appData.</div>
          {quoted?.wrapNative && (
            <div style={{ color: '#666' }}>Selling native ETH: the Safe tx wraps your ETH to WETH first, then sells WETH.</div>
          )}
          <button onClick={onPropose} disabled={busy} style={{ marginTop: 8 }}>Review &amp; propose to Safe</button>
        </div>
      )}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </main>
  );
}

function short(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
