import React, { useState } from 'react';
import PrivacySlider from '../components/PrivacySlider';
import ItemCard from '../components/ItemCard';
import type { Item, PublishResult } from '../api.client';

const PRIVACY_VALUES: ('low' | 'medium' | 'high')[] = ['low', 'medium', 'high'];

interface PublishProps {
  items: Item[];
  onPublish: (text: string, type: 'need' | 'offer', privacy: 'low' | 'medium' | 'high') => Promise<PublishResult & { error?: string }>;
  onWithdraw: (id: string) => Promise<{ error?: string }>;
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}

export default function Publish({ items, onPublish, onWithdraw, onToast }: PublishProps) {
  const [text, setText] = useState('');
  const [type, setType] = useState<'need' | 'offer'>('need');
  const [privacy, setPrivacy] = useState(1); // medium
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmed = text.trim();
    if (!trimmed) return;

    setSubmitting(true);
    const result = await onPublish(trimmed, type, PRIVACY_VALUES[privacy]);
    setSubmitting(false);

    if (result.error) {
      onToast(result.error, 'error');
      return;
    }

    onToast(`Item published! Status: ${result.status}`, 'success');
    setText('');
  }

  async function handleWithdraw(id: string) {
    const result = await onWithdraw(id);
    if (result.error) {
      onToast(result.error, 'error');
    } else {
      onToast('Item withdrawn.', 'info');
    }
  }

  return (
    <div className="screen-container">
      <h2>Publish</h2>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <textarea
            placeholder="Describe what you need or offer..."
            value={text}
            onChange={e => setText(e.target.value)}
            disabled={submitting}
            rows={4}
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Type</label>
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
          </div>

          <div className="form-group">
            <PrivacySlider value={privacy} onChange={setPrivacy} />
          </div>
        </div>

        <button
          className="btn btn-primary"
          type="submit"
          disabled={submitting || !text.trim()}
        >
          {submitting ? 'Publishing...' : 'Publish'}
        </button>
      </form>

      <div className="items-list">
        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </div>
            <div className="empty-title">No items published</div>
            <div className="empty-description">
              Use the form above to publish your first need or offer.
            </div>
          </div>
        ) : (
          items.map(item => (
            <ItemCard key={item.id} item={item} onWithdraw={handleWithdraw} />
          ))
        )}
      </div>
    </div>
  );
}
