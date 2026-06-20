import { useState } from 'react';
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
  const [quote, setQuote] = useState<any>(null);
  const [submitted, setSubmitted] = useState<{ orderUid: string; safeTxHash: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const referral = resolveReferralCode();

  async function onQuote() {
    setError(null); setBusy(true); setQuote(null);
    try {
      setQuote(await getQuote(chainId, owner, sellToken, buyToken, sellAmount));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function onPropose() {
    if (!quote) return;
    setError(null); setBusy(true);
    try {
      const { fullAppData, appDataHash } = await buildAppData(chainId, referral);
      const order = assembleOrder(owner as `0x${string}`, quote, appDataHash);
      setSubmitted(await submitOrder(sdk, chainId, owner as `0x${string}`, order, fullAppData, appDataHash));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (submitted) {
    return <OrderStatus chainId={chainId} orderUid={submitted.orderUid} safeTxHash={submitted.safeTxHash} />;
  }

  const q = quote?.quote ?? quote;
  return (
    <main style={shell}>
      <h1>Ophis Swap</h1>
      <p style={{ color: '#666', marginTop: -8 }}>
        Chain {chainId} · Safe {short(owner)}{referral ? ` · ref ${referral}` : ''}
      </p>
      <label>Sell token (address)
        <input value={sellToken} onChange={(e) => setSellToken(e.target.value)} placeholder="0x..." />
      </label>
      <label>Buy token (address)
        <input value={buyToken} onChange={(e) => setBuyToken(e.target.value)} placeholder="0x..." />
      </label>
      <label>Sell amount (atoms)
        <input value={sellAmount} onChange={(e) => setSellAmount(e.target.value)} placeholder="1000000000000000000" />
      </label>
      <button onClick={onQuote} disabled={busy || !sellToken || !buyToken || !sellAmount}>Get quote</button>
      {q && (
        <div style={{ background: '#f6f6f7', padding: 12, borderRadius: 8, display: 'grid', gap: 4 }}>
          <div>Buy amount (quoted): {q.buyAmount}</div>
          <div>Fee: {q.feeAmount ?? '0'}</div>
          <div style={{ color: '#666' }}>The Ophis partner fee + your referral are carried in appData.</div>
          <button onClick={onPropose} disabled={busy} style={{ marginTop: 8 }}>Review &amp; propose to Safe</button>
        </div>
      )}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
    </main>
  );
}

function short(a: string) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
