import React from 'react';
import StatCard from '../components/StatCard';
import type { StatusResponse, RelayStatus } from '../api.client';

interface Activity {
  type: 'publish' | 'match' | 'channel';
  text: string;
  time: Date;
}

function timeAgo(date: Date): string {
  const now = Date.now();
  const diff = Math.max(0, now - date.getTime());

  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString();
}

interface DashboardProps {
  status: StatusResponse | null;
  channelCount: number;
  relayStatus: RelayStatus | null;
  onRelayToggle: () => void;
  activities: Activity[];
}

export default function Dashboard({
  status,
  channelCount,
  relayStatus,
  onRelayToggle,
  activities,
}: DashboardProps) {
  const relayLabel = relayStatus?.enabled ? 'Relay Active' : 'Relay Off';

  return (
    <div className="screen-container">
      <h2>Dashboard</h2>

      <div className="stats-grid">
        <StatCard label="Items" value={status?.items ?? 0} color="blue" />
        <StatCard label="Matches" value={status?.matches ?? 0} color="purple" />
        <StatCard label="Channels" value={channelCount} color="green" />
        <StatCard
          label="Relay"
          value={status?.relayConnected ? 'Online' : 'Offline'}
          color="gold"
        />
      </div>

      <div className="relay-section">
        <div className="relay-toggle-row">
          <div>
            <h4>Act as Relay</h4>
            <p className="text-sm text-muted">
              Help the network by relaying matches between other nodes.
            </p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={relayStatus?.enabled ?? false}
              onChange={onRelayToggle}
            />
            <span className="switch-track" />
            <span className="switch-label">{relayLabel}</span>
          </label>
        </div>

        {relayStatus?.enabled && relayStatus.stats && (
          <div className="relay-stats">
            <div className="stat-item">
              <span className="label">Port</span>
              <span className="value">{relayStatus.port ?? '-'}</span>
            </div>
            <div className="stat-item">
              <span className="label">Connected Nodes</span>
              <span className="value">{relayStatus.stats.connectedNodes ?? 0}</span>
            </div>
            <div className="stat-item">
              <span className="label">Indexed Items</span>
              <span className="value">{relayStatus.stats.indexedItems ?? 0}</span>
            </div>
          </div>
        )}
      </div>

      <div>
        <h3>Activity</h3>
        <div className="activity-list mt-sm">
          {activities.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
              </div>
              <div className="empty-title">No activity yet</div>
              <div className="empty-description">
                Publish your first need or offer to get started.
              </div>
            </div>
          ) : (
            activities.map((a, i) => (
              <div className="activity-item" key={i}>
                <div className={`activity-dot type-${a.type}`} />
                <div>
                  <div className="activity-text">{a.text}</div>
                  <div className="activity-time">{timeAgo(a.time)}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export type { Activity };
