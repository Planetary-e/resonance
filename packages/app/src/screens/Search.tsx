import React, { useState } from 'react';
import { search, type SearchResult } from '../api.client';

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

interface SearchProps {
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}

export default function Search({ onToast }: SearchProps) {
  const [text, setText] = useState('');
  const [type, setType] = useState<'need' | 'offer'>('need');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmed = text.trim();
    if (!trimmed) return;

    setLoading(true);
    const data = await search(trimmed, type);
    setLoading(false);
    setSearched(true);

    if (data.error) {
      onToast(data.error, 'error');
      setResults([]);
      return;
    }

    setResults(data.results ?? []);
  }

  return (
    <div className="screen-container">
      <h2>Search</h2>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <input
            type="text"
            placeholder="Search for needs or offers..."
            value={text}
            onChange={e => setText(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="flex items-center gap-md">
          <div className="toggle-group">
            <button
              type="button"
              className={`toggle ${type === 'need' ? 'active' : ''}`}
              onClick={() => setType('need')}
            >
              Need
            </button>
            <button
              type="button"
              className={`toggle ${type === 'offer' ? 'active' : ''}`}
              onClick={() => setType('offer')}
            >
              Offer
            </button>
          </div>

          <button
            className="btn btn-primary"
            type="submit"
            disabled={loading || !text.trim()}
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>

      <div className="search-results">
        {searched && results.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <div className="empty-title">No results found</div>
            <div className="empty-description">
              Try a different search or check that the relay is connected.
            </div>
          </div>
        )}

        {results.map((r, i) => {
          const pct = Math.round(r.similarity * 100);
          const color = similarityColor(r.similarity);
          return (
            <div className="search-result" key={i}>
              <div className="search-result-info">
                <span className="search-result-did">{truncateDID(r.did)}</span>
                <span className={`badge badge-${r.itemType || 'offer'}`}>
                  {r.itemType || 'unknown'}
                </span>
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
          );
        })}
      </div>
    </div>
  );
}
