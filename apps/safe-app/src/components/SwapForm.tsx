import { useState, type ChangeEvent } from 'react';
import type SafeAppsSDK from '@safe-global/safe-apps-sdk';
import { getQuote } from '../lib/quote';
import { buildAppData } from '../lib/appData';
import { assembleOrder } from '../lib/order';
import { submitOrder } from '../lib/submit';
import { resolveReferralCode } from '../lib/referral';
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
  // The quote is stored together with the EXACT appData it was priced against, so onPropose
  // submits the same fee-bearing appData the quote reflected (never a fresh/divergent one).
  const [quoted, setQuoted] = useState<{ quote: any; fullAppData: string; appDataHash: string } | null>(null);
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
      const quote = await getQuote(chainId, owner, sellToken, buyToken, sellAmount, fullAppData, appDataHash);
      setQuoted({ quote, fullAppData, appDataHash });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function onPropose() {
    if (!quoted) return;
    setError(null); setBusy(true);
    try {
      const ownerAddr = owner as `0x${string}`;
      const { quote, fullAppData, appDataHash } = quoted;
      const order = assembleOrder(ownerAddr, quote, appDataHash);
      setSubmitted(await submitOrder(sdk, chainId, ownerAddr, order, fullAppData, appDataHash));
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
      <label>Sell token (address)
        <input value={sellToken} onChange={onInput(setSellToken)} placeholder="0x..." />
      </label>
      <label>Buy token (address)
        <input value={buyToken} onChange={onInput(setBuyToken)} placeholder="0x..." />
      </label>
      <label>Sell amount (atoms)
        <input value={sellAmount} onChange={onInput(setSellAmount)} placeholder="1000000000000000000" />
      </label>
      <button onClick={onQuote} disabled={busy || !sellToken || !buyToken || !sellAmount}>Get quote</button>
      {q && (
        <div style={{ background: '#f6f6f7', padding: 12, borderRadius: 8, display: 'grid', gap: 4 }}>
          <div>Buy amount (quoted, after fee): {q.buyAmount}</div>
          <div>Fee: {q.feeAmount ?? '0'}</div>
          <div style={{ color: '#666' }}>Quoted with the Ophis partner fee + your referral in appData.</div>
          <button onClick={onPropose} disabled={busy} style={{ marginTop: 8 }}>Review &amp; propose to Safe</button>
        </div>
      )}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </main>
  );
}

function short(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
