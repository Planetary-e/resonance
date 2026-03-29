import React from 'react';

function truncateDID(did: string | null | undefined): string {
  if (!did) return 'unknown';
  if (did.length <= 24) return did;
  return did.substring(0, 20) + '...';
}

interface TopBarProps {
  did: string | null;
  relayConnected: boolean;
  onLock: () => void;
}

export default function TopBar({ did, relayConnected, onLock }: TopBarProps) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="topbar-brand">Resonance</span>
      </div>

      {did && (
        <span className="topbar-did" title={did}>
          {truncateDID(did)}
        </span>
      )}

      <div className="topbar-right">
        <div className="relay-status">
          <span className={`status-dot ${relayConnected ? 'connected' : 'disconnected'}`} />
          <span>{relayConnected ? 'Connected' : 'Disconnected'}</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onLock} title="Lock session">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Lock
        </button>
      </div>
    </div>
  );
}
