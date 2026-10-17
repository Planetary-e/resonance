import React, { useCallback, useEffect, useState } from 'react';
import { getPrivateRequests, privateRequestAction, holdMailboxCheck, setAutomaticMailboxChecks,
  type HeldPrivateRequest, type PrivateRequestList, type SearchResult } from '../api.client';

export function savedRequestLabel(entry: HeldPrivateRequest, running = false): string {
  if (running || entry.state === 'sending') return 'Running; completion not confirmed';
  if (entry.state === 'held') return 'Saved on this device; not sent';
  if (entry.state === 'outcome-unknown') return 'Interrupted; some requests may have reached a relay';
  if (entry.state === 'expired') return entry.mayHaveBeenSent ? 'Expired; an earlier attempt may have run' : 'Expired; not sent';
  if (entry.state === 'cancelled') return 'Cancelled; not sent';
  return 'Completed';
}
interface Props {
  kind: 'search' | 'mailbox'; refreshKey?: number; canSaveMailbox?: boolean;
  onChange: () => void | Promise<unknown>;
  onResults?: (results: SearchResult[]) => void;
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}
export default function SavedRequests({ kind, refreshKey = 0, canSaveMailbox = true, onChange, onResults, onToast }: Props) {
  const [data, setData] = useState<PrivateRequestList | null>(null);
  const [running, setRunning] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [mailbox, setMailbox] = useState('');
  const refresh = useCallback(async () => {
    const result = await getPrivateRequests();
    if (result.error) return result.error;
    setData(result); return undefined;
  }, []);
  useEffect(() => { void refresh().then(error => { if (error) onToast(error, 'error'); }); }, [refresh, refreshKey]);
  async function act(id: string, action: 'release' | 'cancel' | 'remove') {
    if (action === 'release') setRunning(ids => [...ids, id]);
    else setBusy(true);
    try {
      const result = await privateRequestAction(id, action);
      if (result.error) onToast(result.error, 'error');
      else if (result.result?.kind === 'search') onResults?.(result.result.results);
      else if (result.result?.kind === 'mailbox') onToast('Mailbox check completed.', 'success');
      const error = await refresh(); if (error) onToast(error, 'error');
      await onChange();
    } finally { setRunning(ids => ids.filter(value => value !== id)); setBusy(false); }
  }
  async function changeMode() {
    if (!data) return;
    setBusy(true);
    try {
      const result = await setAutomaticMailboxChecks(!data.automaticMailboxes);
      if (result.error) onToast(result.error, 'error');
      await refresh(); await onChange();
    } finally { setBusy(false); }
  }
  async function saveMailbox() {
    const target = data?.mailboxes.find(candidate => candidate.id === mailbox);
    if (!target) return;
    setBusy(true);
    try {
      const result = await holdMailboxCheck(target.kind, target.id);
      if (result.error) onToast(result.error, 'error');
      else onToast('Check saved. Automatic mailbox checks are paused.', 'success');
      await refresh(); await onChange();
    } finally { setBusy(false); }
  }
  if (!data) return <p>Loading saved requests…</p>;
  const entries = data.requests.filter(entry => kind === 'search' ? entry.kind === 'search' : entry.kind !== 'search');
  return <section className="items-list">
    <h3>{kind === 'search' ? 'Saved searches' : 'Mailbox checks'}</h3>
    {kind === 'mailbox' && <>
      <p>{data.automaticMailboxes ? 'Automatic mailbox checks are enabled.' : 'Automatic mailbox checks are paused, including after restart.'}</p>
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void changeMode()}>
        {data.automaticMailboxes ? 'Pause automatic checks' : 'Enable automatic checks'}
      </button>
      {canSaveMailbox && <div className="form-group">
        <label htmlFor="saved-mailbox">Mailbox to check later</label>
        <select id="saved-mailbox" value={mailbox} onChange={event => setMailbox(event.target.value)} disabled={busy}>
          <option value="">Choose a publication or channel</option>
          {data.mailboxes.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" disabled={busy || !mailbox} onClick={() => void saveMailbox()}>Save mailbox check</button>
      </div>}
      <p>Saving a check also pauses automatic checks. Run fetches that mailbox and sends any required acknowledgements, connection responses, and pending messages. Earlier requests may already have been sent. Other explicit Send actions still send immediately.</p>
    </>}
    <p>Saved requests expire after 24 hours and never run automatically. Run again creates fresh requests and may use new access tokens. Holding does not hide the timing of a later run.</p>
    {entries.length === 0 && <p>No saved {kind === 'search' ? 'searches' : 'mailbox checks'}.</p>}
    {entries.map(entry => {
      const isRunning = running.includes(entry.id) || entry.state === 'sending';
      return <div className="item-card" key={entry.id}>
        <div className="item-text">{entry.label}</div>
        <p>{savedRequestLabel(entry, isRunning)}</p>
        <div className="item-meta">
          <span>Expires {new Date(entry.expiresAt).toLocaleString()}</span>
          {!isRunning && ['held', 'outcome-unknown'].includes(entry.state) && <button className="btn btn-primary btn-sm" disabled={busy}
            onClick={() => void act(entry.id, 'release')}>{entry.state === 'held' ? 'Run' : 'Run again (new request)'}</button>}
          {(isRunning || entry.state === 'held') && <button className="btn btn-ghost btn-sm" disabled={busy}
            onClick={() => void act(entry.id, 'cancel')}>{isRunning ? 'Stop' : 'Cancel'}</button>}
          {!isRunning && !['held', 'sending'].includes(entry.state) && <button className="btn btn-ghost btn-sm" disabled={busy}
            onClick={() => void act(entry.id, 'remove')}>Remove request history</button>}
          {entry.result?.kind === 'search' && <button className="btn btn-ghost btn-sm"
            onClick={() => { if (entry.result?.kind === 'search') onResults?.(entry.result.results); }}>Show saved results</button>}
        </div>
        {entry.result?.kind === 'mailbox' && <p>{entry.result.matchesAdded} new matches; {entry.result.messagesProcessed + entry.result.channelOperationsProcessed} messages processed.</p>}
      </div>;
    })}
  </section>;
}
