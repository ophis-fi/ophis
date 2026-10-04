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


// CoW order statuses that will not change again, so polling can stop.
const TERMINAL_STATUSES = new Set(['fulfilled', 'cancelled', 'expired']);

export function OrderStatus({ chainId, orderUid, safeTxHash, enrollmentWarning }: Props) {
  const [status, setStatus] = useState<string>('presignaturePending');
  const [statusUnavailable, setStatusUnavailable] = useState(false);

  useEffect(() => {
    // Stop polling once the order reaches a terminal state (fulfilled/cancelled/expired).
    if (TERMINAL_STATUSES.has(status)) return;

    let stop = false;
    const api = ophisOrderBook(chainId);
    const tick = async () => {
      try {
        const order = await api.getOrder(orderUid);
        if (!stop) {
          setStatus(order.status);
          setStatusUnavailable(false);
        }
      } catch {
        if (!stop) setStatusUnavailable(true);
      }
    };
    const id = setInterval(tick, 5000);
    void tick();
    return () => { stop = true; clearInterval(id); };
  }, [chainId, orderUid, status]);

  const pendingSignature = status === 'presignaturePending';
  const title = pendingSignature ? 'Order proposed'
    : status === 'fulfilled' ? 'Order fulfilled'
    : status === 'cancelled' ? 'Order cancelled'
    : status === 'expired' ? 'Order expired'
    : 'Order status';

  return (
    <main>
      <h1>{title}</h1>
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
      {pendingSignature && (
        <p>
          The order is waiting for Safe authorization. Owners must co-sign and execute the proposed
          Safe transaction before it can settle.
        </p>
      )}
      {statusUnavailable && <p role="status">Could not refresh order status. Showing the last known status; retrying.</p>}
      <div style={{ background: '#f6f6f7', padding: 12, borderRadius: 8, display: 'grid', gap: 4 }}>
        <div>Status: <strong>{status}</strong></div>
        <div>Order: <code>{short(orderUid)}</code></div>
        <div>Safe tx: <code>{short(safeTxHash)}</code></div>
      </div>
      {status === 'open' && <p>The order is open and awaiting settlement. It can also expire or be cancelled.</p>}
      {status === 'fulfilled' && <p>The order has settled.</p>}
      {status === 'cancelled' && <p>The order was cancelled.</p>}
      {status === 'expired' && <p>The order expired before settlement.</p>}
    </main>
  );
}

function short(a: string) { return a ? `${a.slice(0, 8)}…${a.slice(-6)}` : ''; }
