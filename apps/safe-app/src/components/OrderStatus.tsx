import { useEffect, useState } from 'react';
import { ophisOrderBook } from '../lib/quote';

interface Props {
  chainId: number;
  orderUid: string;
  safeTxHash: string;
  // Set when rebate-indexer enrollment failed at submit time. Non-blocking: the order still
  // executes; we surface it so the trader can retry enrollment rather than silently miss the rebate.
  enrollmentWarning?: string;
}

const shell = { fontFamily: 'system-ui', padding: 24, maxWidth: 520, display: 'grid', gap: 12 } as const;

// CoW order statuses that will not change again, so polling can stop.
const TERMINAL_STATUSES = new Set(['fulfilled', 'cancelled', 'expired']);

export function OrderStatus({ chainId, orderUid, safeTxHash, enrollmentWarning }: Props) {
  const [status, setStatus] = useState<string>('presignaturePending');

  useEffect(() => {
    // Stop polling once the order reaches a terminal state (fulfilled/cancelled/expired).
    if (TERMINAL_STATUSES.has(status)) return;

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
  }, [chainId, orderUid, status]);

  return (
    <main style={shell}>
      <h1>Order proposed</h1>
      {enrollmentWarning && (
        <div
          role="alert"
          style={{
            background: '#fff4e5',
            border: '1px solid #ffcc80',
            color: '#7a4f01',
            padding: 12,
            borderRadius: 8,
          }}
        >
          Rebate registration failed: your trade still executes, but the rebate may not be tracked.
          You can retry by reopening this Safe App. ({enrollmentWarning})
        </div>
      )}
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
