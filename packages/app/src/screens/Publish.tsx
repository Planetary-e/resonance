import React, { useState } from 'react';
import PrivacySlider from '../components/PrivacySlider';
import ItemCard from '../components/ItemCard';
import type { Item, PublishResult } from '../api.client';

const PRIVACY_VALUES: ('low' | 'medium' | 'high')[] = ['low', 'medium', 'high'];

interface PublishProps {
  items: Item[];
  privateDeliveryAvailable: boolean;
  onOutboxAction: (id: string, action: 'release' | 'cancel' | 'remove') => Promise<{ error?: string }>;
  onPublish: (text: string, type: 'need' | 'offer', privacy: 'low' | 'medium' | 'high', delivery: 'send' | 'hold') => Promise<PublishResult & { error?: string }>;
  onWithdraw: (id: string) => Promise<{ error?: string }>;
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}

export default function Publish({ items, privateDeliveryAvailable, onPublish, onWithdraw, onOutboxAction, onToast }: PublishProps) {
  const [text, setText] = useState('');
  const [type, setType] = useState<'need' | 'offer'>('need');
  const [privacy, setPrivacy] = useState(1); // medium
  const [submitting, setSubmitting] = useState(false);
  const [delivery, setDelivery] = useState<'send' | 'hold'>('send');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmed = text.trim();
    if (!trimmed) return;

    setSubmitting(true);
    const result = await onPublish(trimmed, type, PRIVACY_VALUES[privacy], privateDeliveryAvailable ? delivery : 'send');
    setSubmitting(false);

    if (result.error) {
      onToast(result.error, 'error');
      return;
    }

    onToast(result.status === 'held' ? 'Saved on this device; not sent.'
      : result.status === 'published' ? 'Published.' : 'Saved locally; delivery not confirmed.',
      result.status === 'local' ? 'info' : 'success');
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

        {privateDeliveryAvailable && <div className="form-group">
          <label htmlFor="publication-delivery">Delivery</label>
          <select id="publication-delivery" value={delivery} disabled={submitting}
            onChange={event => setDelivery(event.target.value as 'send' | 'hold')}>
            <option value="send">Send now</option>
            <option value="hold">Save on this device</option>
          </select>
          <p>Saved publications stay encrypted here until you choose Send. They expire after seven days and never send automatically.
            Holding does not hide the timing of a later send.</p>
        </div>}

        <button
          className="btn btn-primary"
          type="submit"
          disabled={submitting || !text.trim()}
        >
          {submitting ? 'Saving...' : privateDeliveryAvailable && delivery === 'hold' ? 'Save on this device' : 'Publish'}
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
            <div className="empty-title">No saved items</div>
            <div className="empty-description">
              Use the form above to publish your first need or offer.
            </div>
          </div>
        ) : (
          items.map(item => (
            <ItemCard key={item.id} item={item} onWithdraw={handleWithdraw}
              onOutboxAction={onOutboxAction} onToast={onToast} />
          ))
        )}
      </div>
    </div>
  );
}
