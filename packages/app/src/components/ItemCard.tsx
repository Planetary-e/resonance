import React from 'react';
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
}

export default function ItemCard({ item, onWithdraw }: ItemCardProps) {
  return (
    <div className="item-card">
      <div className="item-header">
        <span className={`badge badge-${item.type}`}>{item.type}</span>
        <span className={`badge badge-${item.status}`}>{item.status}</span>
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
        {item.status !== 'withdrawn' && (
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
