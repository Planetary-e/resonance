import React from 'react';
import MatchCard from '../components/MatchCard';
import type { Match } from '../api.client';

interface MatchesProps {
  matches: Match[];
  onConnect: (matchId: string) => Promise<{ channelId?: string; error?: string }>;
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void;
  onSwitchToChannels: () => void;
}

export default function Matches({ matches, onConnect, onToast, onSwitchToChannels }: MatchesProps) {
  async function handleConnect(matchId: string) {
    const result = await onConnect(matchId);
    if (result.error) {
      onToast(result.error, 'error');
      return;
    }
    onToast('Channel initiated! Waiting for partner...', 'info');
    onSwitchToChannels();
  }

  return (
    <div className="screen-container">
      <h2>Matches</h2>

      {matches.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </div>
          <div className="empty-title">No matches yet</div>
          <div className="empty-description">
            When someone matches with your published items, they will appear here.
          </div>
        </div>
      ) : (
        matches.map(m => (
          <MatchCard key={m.id} match={m} onConnect={handleConnect} />
        ))
      )}
    </div>
  );
}
