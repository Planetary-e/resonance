import React, { useState, useRef, useEffect } from 'react';
import type { Channel as ChannelData } from '../api.client';
import type { ChannelMessage } from '../hooks/useChannels';

function truncateDID(did: string | null | undefined): string {
  if (!did) return 'unknown';
  if (did.length <= 24) return did;
  return did.substring(0, 20) + '...';
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);

  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : new Date(dateStr).toLocaleDateString();
}

// ============================================================================
// Channel List (no active channel)
// ============================================================================

function ChannelList({
  channels,
  onSelect,
}: {
  channels: ChannelData[];
  onSelect: (id: string) => void;
}) {
  if (channels.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div className="empty-title">No channels open</div>
        <div className="empty-description">
          Channels open when you connect with a match for gradual disclosure.
        </div>
      </div>
    );
  }

  return (
    <>
      {channels.map(ch => {
        const stateClass =
          ch.state === 'open' ? 'connected'
          : ch.state === 'pending' ? 'pending'
          : 'closed';
        return (
          <div
            className="channel-item"
            key={ch.id}
            onClick={() => onSelect(ch.id)}
          >
            <div className="channel-info">
              <span className={`status-dot ${stateClass}`} />
              <span className="channel-peer">
                {truncateDID(ch.partnerDID || ch.matchId || ch.id)}
              </span>
            </div>
            <span className={`badge badge-${ch.state || 'pending'}`}>
              {ch.state || 'unknown'}
            </span>
          </div>
        );
      })}
    </>
  );
}

// ============================================================================
// Active Channel View
// ============================================================================

function ChannelView({
  channel,
  messages,
  onDisclose,
  onAccept,
  onReject,
  onClose,
  onBack,
  onToast,
}: {
  channel: ChannelData;
  messages: ChannelMessage[];
  onDisclose: (text: string, level: string) => Promise<{ error?: string }>;
  onAccept: (msg?: string) => Promise<{ error?: string }>;
  onReject: (reason?: string) => Promise<{ error?: string }>;
  onClose: () => Promise<{ error?: string }>;
  onBack: () => void;
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}) {
  const [text, setText] = useState('');
  const [level, setLevel] = useState('general');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const isOpen = channel.state === 'open';

  async function handleDisclose(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    const result = await onDisclose(trimmed, level);
    if (result.error) {
      onToast(result.error, 'error');
    } else {
      setText('');
    }
  }

  async function handleAccept() {
    const result = await onAccept();
    if (result.error) {
      onToast(result.error, 'error');
    } else {
      onToast('Connection accepted.', 'success');
    }
  }

  async function handleReject() {
    const result = await onReject();
    if (result.error) {
      onToast(result.error, 'error');
    } else {
      onToast('Connection rejected.', 'info');
    }
  }

  async function handleClose() {
    const result = await onClose();
    if (result.error) {
      onToast(result.error, 'error');
    } else {
      onToast('Channel closed.', 'info');
    }
  }

  const stateClass =
    channel.state === 'open' ? 'connected'
    : channel.state === 'pending' ? 'pending'
    : 'closed';

  return (
    <div className="channel-view">
      {/* Header */}
      <div className="channel-header">
        <div className="channel-title">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            Back
          </button>
          <span className={`status-dot ${stateClass}`} />
          <span className="text-mono text-sm">
            {truncateDID(channel.partnerDID)}
          </span>
          <span className={`badge badge-${channel.state}`}>
            {channel.state}
          </span>
          {channel.similarity != null && (
            <span className="text-sm text-muted">
              {Math.round(channel.similarity * 100)}% similar
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="channel-messages">
        {messages.length === 0 ? (
          <div className="message-system">
            No messages yet. Start by sharing a disclosure.
          </div>
        ) : (
          messages.map((m, i) => {
            if (m.type === 'system') {
              return (
                <div className="message-system" key={i}>
                  {m.text}
                </div>
              );
            }
            return (
              <div
                className={`message ${m.from === 'me' ? 'sent' : 'received'}`}
                key={i}
              >
                <div className="message-avatar">
                  {m.from === 'me' ? 'You' : 'P'}
                </div>
                <div>
                  <div className="message-bubble">
                    {m.level && (
                      <div className="message-level">{m.level}</div>
                    )}
                    {m.text}
                  </div>
                  <div className="message-time">{timeAgo(m.time)}</div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Actions */}
      <div className="channel-actions">
        {isOpen && (
          <form className="disclose-form" onSubmit={handleDisclose}>
            <select value={level} onChange={e => setLevel(e.target.value)}>
              <option value="general">General</option>
              <option value="specific">Specific</option>
              <option value="identifying">Identifying</option>
            </select>
            <input
              type="text"
              placeholder="Share a disclosure..."
              value={text}
              onChange={e => setText(e.target.value)}
            />
            <button
              className="btn btn-primary btn-sm"
              type="submit"
              disabled={!text.trim()}
            >
              Send
            </button>
          </form>
        )}

        {isOpen && (
          <div className="channel-btns">
            <button className="btn btn-success btn-sm" onClick={handleAccept}>
              Accept
            </button>
            <button className="btn btn-danger btn-sm" onClick={handleReject}>
              Reject
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Main Channel Screen
// ============================================================================

interface ChannelScreenProps {
  channels: ChannelData[];
  activeChannel: ChannelData | null;
  messages: ChannelMessage[];
  onSelect: (channelId: string | null) => Promise<void>;
  onDisclose: (text: string, level: string) => Promise<{ error?: string }>;
  onAccept: (msg?: string) => Promise<{ error?: string }>;
  onReject: (reason?: string) => Promise<{ error?: string }>;
  onClose: () => Promise<{ error?: string }>;
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}

export default function ChannelScreen({
  channels,
  activeChannel,
  messages,
  onSelect,
  onDisclose,
  onAccept,
  onReject,
  onClose,
  onToast,
}: ChannelScreenProps) {
  return (
    <div className="screen-container">
      <h2>Channels</h2>

      {activeChannel ? (
        <ChannelView
          channel={activeChannel}
          messages={messages}
          onDisclose={onDisclose}
          onAccept={onAccept}
          onReject={onReject}
          onClose={onClose}
          onBack={() => onSelect(null)}
          onToast={onToast}
        />
      ) : (
        <ChannelList channels={channels} onSelect={id => onSelect(id)} />
      )}
    </div>
  );
}
