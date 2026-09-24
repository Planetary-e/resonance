import React, { useEffect, useState } from 'react';
import StatCard from '../components/StatCard';
import type { StatusResponse, RelayStatus, RelayOwnerControls } from '../api.client';

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
  onRelayToggle: (contacts: string[], controls: RelayOwnerControls) => void;
  activities: Activity[];
}

export default function Dashboard({
  status,
  channelCount,
  relayStatus,
  onRelayToggle,
  activities,
}: DashboardProps) {
  const relayLabel = relayStatus?.running ? 'Relay Active'
    : relayStatus?.enabled ? 'Relay Starting' : 'Relay Off';
  const [contactText, setContactText] = useState('');
  const [storageText, setStorageText] = useState('');
  const [bandwidthText, setBandwidthText] = useState('');
  const [totalBandwidthText, setTotalBandwidthText] = useState('');
  const [cpuText, setCpuText] = useState('');
  const [hoursText, setHoursText] = useState('');
  const [onlyWhenCharging, setOnlyWhenCharging] = useState(false);
  useEffect(() => {
    setContactText((relayStatus?.contacts ?? []).join(', '));
    setStorageText(String(relayStatus?.controls.publicationStorageMiB ?? ''));
    setBandwidthText(String(relayStatus?.controls.newWorkIngressMiBPerHour ?? ''));
    setTotalBandwidthText(String(relayStatus?.controls.totalBandwidthMiBPerHour ?? ''));
    setCpuText(String(relayStatus?.controls.cpuMillisecondsPerMinute ?? ''));
    setHoursText(relayStatus?.controls.activeHours ?? '');
    setOnlyWhenCharging(relayStatus?.controls.onlyWhenCharging ?? false);
  }, [relayStatus?.contacts?.join(','), JSON.stringify(relayStatus?.controls)]);
  const contacts = contactText.split(',').map(value => value.trim()).filter(Boolean);
  const controls: RelayOwnerControls = {
    ...(storageText.trim() ? { publicationStorageMiB: Number(storageText) } : {}),
    ...(bandwidthText.trim() ? { newWorkIngressMiBPerHour: Number(bandwidthText) } : {}),
    ...(totalBandwidthText.trim() ? { totalBandwidthMiBPerHour: Number(totalBandwidthText) } : {}),
    ...(cpuText.trim() ? { cpuMillisecondsPerMinute: Number(cpuText) } : {}),
    ...(hoursText.trim() ? { activeHours: hoursText.trim() } : {}),
    onlyWhenCharging,
  };

  return (
    <div className="screen-container">
      <h2>Dashboard</h2>

      <div className="stats-grid">
        <StatCard label="Items" value={status?.items ?? 0} color="blue" />
        <StatCard label="Matches" value={status?.matches ?? 0} color="purple" />
        <StatCard label="Channels" value={channelCount} color="green" />
        <StatCard
          label="Last relay request"
          value={status?.relayActivity === 'succeeded' ? 'Worked'
            : status?.relayActivity === 'failed' ? 'Failed' : 'Not checked'}
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
              onChange={() => onRelayToggle(contacts, controls)}
            />
            <span className="switch-track" />
            <span className="switch-label">{relayLabel}</span>
          </label>
        </div>

        <label className="text-sm" htmlFor="relay-contacts">Volunteer relay contacts</label>
        <input
          id="relay-contacts"
          type="text"
          value={contactText}
          onChange={event => setContactText(event.target.value)}
          disabled={relayStatus?.enabled ?? false}
          placeholder="wss://relay.example, wss://another.example"
        />
        <p className="text-sm text-muted">
          Add relay addresses to contribute through outbound connections. Leave blank for local-only relay mode.
        </p>
        <div className="relay-controls">
          <label className="text-sm" htmlFor="relay-storage">Publication storage limit (MiB)</label>
          <input id="relay-storage" type="number" min="1" value={storageText}
            onChange={event => setStorageText(event.target.value)}
            disabled={relayStatus?.enabled ?? false} placeholder="1024" />
          <label className="text-sm" htmlFor="relay-bandwidth">New-work ingress budget (MiB/hour)</label>
          <input id="relay-bandwidth" type="number" min="0" value={bandwidthText}
            onChange={event => setBandwidthText(event.target.value)}
            disabled={relayStatus?.enabled ?? false} placeholder="No limit" />
          <label className="text-sm" htmlFor="relay-total-bandwidth">Total traffic budget (MiB/hour)</label>
          <input id="relay-total-bandwidth" type="number" min="0" value={totalBandwidthText}
            onChange={event => setTotalBandwidthText(event.target.value)}
            disabled={relayStatus?.enabled ?? false} placeholder="No limit" />
          <label className="text-sm" htmlFor="relay-cpu">CPU budget (ms/minute)</label>
          <input id="relay-cpu" type="number" min="0" max="60000" value={cpuText}
            onChange={event => setCpuText(event.target.value)}
            disabled={relayStatus?.enabled ?? false} placeholder="No limit" />
          <label className="text-sm" htmlFor="relay-hours">Active hours (local time)</label>
          <input id="relay-hours" type="text" value={hoursText}
            onChange={event => setHoursText(event.target.value)}
            disabled={relayStatus?.enabled ?? false} placeholder="08:00-22:00" />
          <label className="text-sm">
            <input type="checkbox" checked={onlyWhenCharging}
              onChange={event => setOnlyWhenCharging(event.target.checked)}
              disabled={relayStatus?.enabled ?? false} />
            Accept new work only while charging
          </label>
        </div>
        <p className="text-sm text-muted">
          These limits pause new work. The relay continues handling accepted records, repairs, acknowledgements, and withdrawals.
        </p>
        {(relayStatus?.storageCommitmentFloorBytes ?? 0) > 0 && (
          <p className="text-sm text-muted">
            Minimum storage limit for accepted data: {Math.ceil(
              (relayStatus?.storageCommitmentFloorBytes ?? 0) / 1_048_576,
            )} MiB. A lower setting is rejected when the relay starts.
          </p>
        )}

        {relayStatus?.enabled && relayStatus.stats && (
          <div className="relay-stats">
            <div className="stat-item relay-own-id">
              <span className="label">Relay ID to share with a trusted contact</span>
              <span className="value">{relayStatus.stats.relay_id}</span>
            </div>
            <div className="stat-item">
              <span className="label">Port</span>
              <span className="value">{relayStatus.port ?? '-'}</span>
            </div>
            <div className="stat-item">
              <span className="label">Connected Relays</span>
              <span className="value">{relayStatus.stats.connected_relays ?? 0}</span>
            </div>
            <div className="stat-item">
              <span className="label">Authenticated inbound / outbound links</span>
              <span className="value">{relayStatus.stats.inbound_authenticated_relays ?? 0} / {relayStatus.stats.outbound_authenticated_relays ?? 0}</span>
            </div>
            <div className="stat-item">
              <span className="label">Connected query paths</span>
              <span className="value">{relayStatus.stats.connected_query_peers ?? 0}</span>
            </div>
            <div className="stat-item">
              <span className="label">Direct endpoints confirmed by peers (5 min)</span>
              <span className="value">{relayStatus.stats.peer_confirmed_direct_endpoints ?? 0}</span>
            </div>
            <div className="stat-item">
              <span className="label">Active Publications</span>
              <span className="value">{relayStatus.stats.active_publications ?? 0}</span>
            </div>
            <div className="stat-item">
              <span className="label">Placements at Minimum</span>
              <span className="value">
                {relayStatus.stats.minimum_confirmed_placements ?? 0}
                /{relayStatus.stats.placement_intents ?? 0}
              </span>
            </div>
            <div className="stat-item">
              <span className="label">Publication Storage</span>
              <span className="value">
                {Math.round((relayStatus.stats.publication_storage_reserved_bytes ?? 0) / 1_048_576)}
                /{Math.round((relayStatus.stats.publication_storage_quota_bytes ?? 0) / 1_048_576)} MiB
              </span>
            </div>
            <div className="stat-item">
              <span className="label">Relay data files</span>
              <span className="value">{((relayStatus.stats.data_file_bytes ?? 0) / 1_048_576).toFixed(2)} MiB</span>
            </div>
            <div className="stat-item">
              <span className="label">Mailbox / journal retained</span>
              <span className="value">{((relayStatus.stats.mailbox_storage_reserved_bytes ?? 0) / 1_048_576).toFixed(2)} / {((relayStatus.stats.journal_bytes ?? 0) / 1_048_576).toFixed(2)} MiB</span>
            </div>
            <div className="stat-item">
              <span className="label">Mailbox minimum quota</span>
              <span className="value">{((relayStatus.stats.mailbox_commitment_floor_bytes ?? 0) / 1_048_576).toFixed(2)} MiB</span>
            </div>
            <div className="stat-item">
              <span className="label">Network in / out (lifetime, including LAN)</span>
              <span className="value">{(((relayStatus.stats.transport_ingress_bytes ?? 0) + (relayStatus.stats.lan_ingress_bytes ?? 0)) / 1_048_576).toFixed(2)} / {(((relayStatus.stats.transport_egress_bytes ?? 0) + (relayStatus.stats.lan_egress_bytes ?? 0)) / 1_048_576).toFixed(2)} MiB</span>
            </div>
            <div className="stat-item">
              <span className="label">Process CPU (lifetime)</span>
              <span className="value">{((relayStatus.stats.process_cpu_milliseconds ?? 0) / 1_000).toFixed(1)} s</span>
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
