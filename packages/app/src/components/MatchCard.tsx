import React from 'react';
import type { Match, Item } from '../api.client';

function truncateDID(did: string | null | undefined): string {
  if (!did) return 'unknown';
  if (did.length <= 24) return did;
  return did.substring(0, 20) + '...';
}

function similarityColor(sim: number): string {
  if (sim >= 0.8) return '#6cffa0';
  if (sim >= 0.6) return '#6c8cff';
  if (sim >= 0.4) return '#ffc86c';
  return '#ff6c8c';
}

interface MatchCardProps {
  match: Match;
  item?: Item;
  onConnect: (matchId: string) => void;
}

export default function MatchCard({ match, item, onConnect }: MatchCardProps) {
  const pct = Math.round((match.similarity || 0) * 100);
  const color = similarityColor(match.similarity || 0);

  return (
    <div className="match-card">
      <div className="match-header">
        <div className="match-info">
          {item && (
            <div className="match-item-text">
              <span className={`item-type-badge ${item.type}`}>{item.type}</span>
              {item.rawText}
            </div>
          )}
          <span className="match-peer">{truncateDID(match.partnerDID)}</span>
        </div>
        <div className="similarity-bar">
          <div className="similarity-track">
            <div
              className="similarity-fill"
              style={{ width: `${pct}%`, background: color }}
            />
          </div>
          <span className="similarity-value" style={{ color }}>{pct}%</span>
        </div>
      </div>

      <div className="match-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={() => onConnect(match.id)}
        >
          Open Channel
        </button>
      </div>
    </div>
  );
}
