import React, { useState } from 'react';
import type { Item } from '../api.client';

function timeAgo(dateStr: string | undefined): string {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);

  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(dateStr).toLocaleDateString();
}

interface ItemCardProps {
  item: Item;
  onWithdraw: (id: string) => void;
  onOutboxAction?: (id: string, action: 'release' | 'cancel' | 'remove') => Promise<{ error?: string }>;
  onToast?: (message: string, type?: 'info' | 'success' | 'error') => void;
}

export default function ItemCard({ item, onWithdraw, onOutboxAction, onToast }: ItemCardProps) {
  const [sending, setSending] = useState(false);
  const [changing, setChanging] = useState(false);
  const delivery = item.delivery;
  const state = sending ? 'sending' : delivery?.state;
  const deliveryLabel = state === 'held' ? 'Saved on this device; not sent'
    : state === 'sending' ? 'Sending; delivery not confirmed'
    : state === 'outcome-unknown' ? 'Delivery not confirmed; a relay may have accepted it'
    : state === 'expired' ? (delivery?.mayHaveBeenSent ? 'Expired; earlier delivery not confirmed' : 'Expired; not sent')
    : state === 'cancelled' ? 'Cancelled; not sent' : item.status;
  async function act(action: 'release' | 'cancel' | 'remove') {
    if (!delivery || !onOutboxAction) return;
    if (action === 'release') setSending(true); else setChanging(true);
    try {
      const result = await onOutboxAction(delivery.id, action);
      if (result.error) onToast?.(result.error, 'error');
      else if (action === 'release') onToast?.('Published.', 'success');
    } finally { if (action === 'release') setSending(false); else setChanging(false); }
  }
  return (
    <div className="item-card">
      <div className="item-header">
        <span className={`badge badge-${item.type}`}>{item.type}</span>
        <span className={`badge badge-${item.status}`}>{deliveryLabel}</span>
      </div>

      <div className="item-text">{item.rawText}</div>

      <div className="item-meta">
        <span className="privacy-level">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 1v14M1 8h14" opacity="0.3" />
            <circle cx="8" cy="8" r="3" />
          </svg>
          Privacy: {item.privacyLevel}
        </span>
        <span>{timeAgo(item.createdAt)}</span>
        {delivery && state !== 'delivered' && <span>Expires {new Date(delivery.expiresAt).toLocaleString()}</span>}
        {(state === 'held' || state === 'outcome-unknown') && <button className="btn btn-primary btn-sm"
          disabled={changing} onClick={() => void act('release')}>{state === 'held' ? 'Send' : 'Retry same publication'}</button>}
        {(state === 'held' || state === 'sending') && <button className="btn btn-ghost btn-sm"
          disabled={changing} onClick={() => void act('cancel')}>Cancel{state === 'sending' ? ' send' : ''}</button>}
        {['delivered', 'cancelled', 'expired'].includes(state ?? '') && <button className="btn btn-ghost btn-sm"
          disabled={changing} onClick={() => void act('remove')}>{state === 'delivered' ? 'Remove delivery history' : 'Remove saved item'}</button>}
        {(!delivery || state === 'delivered') && item.status !== 'withdrawn' && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onWithdraw(item.id)}
          >
            Withdraw
          </button>
        )}
      </div>
    </div>
  );
}
