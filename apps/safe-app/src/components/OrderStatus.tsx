import { useEffect, useState } from 'react';
import { ophisOrderBook } from '../lib/quote';

interface Props { chainId: number; orderUid: string; safeTxHash: string; }

const shell = { fontFamily: 'system-ui', padding: 24, maxWidth: 520, display: 'grid', gap: 12 } as const;

export function OrderStatus({ chainId, orderUid, safeTxHash }: Props) {
  const [status, setStatus] = useState<string>('presignaturePending');

  useEffect(() => {
    let stop = false;
    const api = ophisOrderBook(chainId);
    const tick = async () => {
      try {
        const o: any = await api.getOrder(orderUid);
        if (!stop) setStatus(o.status);
      } catch { /* transient; keep polling */ }
    };
    const id = setInterval(tick, 5000);
    void tick();
    return () => { stop = true; clearInterval(id); };
  }, [chainId, orderUid]);

  return (
    <main style={shell}>
      <h1>Order proposed</h1>
      <p>
        The <code>setPreSignature</code> transaction is in your Safe queue. Owners must co-sign and
        execute it before the order goes live.
      </p>
      <div style={{ background: '#f6f6f7', padding: 12, borderRadius: 8, display: 'grid', gap: 4 }}>
        <div>Status: <strong>{status}</strong></div>
        <div>Order: <code>{short(orderUid)}</code></div>
        <div>Safe tx: <code>{short(safeTxHash)}</code></div>
      </div>
      <p style={{ color: '#666' }}>
        Once owners execute the Safe tx, status moves from <code>presignaturePending</code> to{' '}
        <code>open</code>, then <code>fulfilled</code> after the solver settles.
      </p>
    </main>
  );
}

function short(a: string) { return a ? `${a.slice(0, 8)}…${a.slice(-6)}` : ''; }
