import { useEffect, useRef, useState } from 'react';
import { getRelayStorage, reviewRelayStorage, applyRelayStorage, cancelRelayStorage,
  type RelayStorageStatus, type RelayStorageReview, type RelayStorageOperation } from '../api.client';
const mib = (bytes: number) => (bytes / 1048576).toFixed(2);
export default function RelayStorage({ onBusyChange, blocked = false, maintenanceActive }: {
  onBusyChange: (busy: boolean) => void; blocked?: boolean; maintenanceActive: boolean;
}) {
  const [state, setState] = useState<RelayStorageStatus | null>(null), [limit, setLimit] = useState('4096');
  const [plan, setPlan] = useState<{ operation: RelayStorageOperation; review: RelayStorageReview } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const active = useRef<RelayStorageOperation | null>(null), mounted = useRef(true), deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  async function refresh() {
    const value = await getRelayStorage(); if (!mounted.current) return;
    if (value.error) { setState(null); setError(value.error); } else setState(value);
  }
  function clear() { clearTimeout(deadline.current); active.current = null; setPlan(null); onBusyChange(false); }
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => { if (mounted.current) setError('Storage status is unavailable.'); });
    return () => {
      mounted.current = false; clearTimeout(deadline.current);
      if (active.current) void cancelRelayStorage(active.current).catch(() => {});
      active.current = null;
    };
  }, [maintenanceActive]);
  async function review(operation: RelayStorageOperation, recover = false) {
    setBusy(true); onBusyChange(true); setError(''); setMessage(''); active.current = operation;
    try {
      const limitBytes = Number(limit) * 1048576;
      if (operation !== 'activation' && !recover && (!Number.isSafeInteger(limitBytes) || limitBytes < 1)) throw new Error('Enter a positive limit in MiB.');
      const input = operation === 'bootstrap' ? recover ? { mode: 'recover' } : { mode: 'new', limitBytes }
        : operation === 'activation' ? {} : { limitBytes };
      const value = await reviewRelayStorage(operation, input);
      if (!mounted.current) { await cancelRelayStorage(operation); return; }
      if (value.error) throw new Error(value.error);
      setPlan({ operation, review: value });
      // The server owns the actual deadline. This timer only removes stale UI
      // approval, and explicitly releases a review if it is still held.
      deadline.current = setTimeout(() => {
        void cancelRelayStorage(operation).catch(() => {}); clear();
        setMessage('Review expired. Review the current storage state again.');
      }, 60000);
    } catch (cause) {
      if (mounted.current) { clear(); setError(cause instanceof Error ? cause.message : 'Storage review failed.'); }
    } finally { if (mounted.current) setBusy(false); }
  }
  async function apply() {
    if (!plan) return; setBusy(true); setError(''); clearTimeout(deadline.current);
    try {
      const result = await applyRelayStorage(plan.operation, plan.review.approvalDigest);
      if (!mounted.current) return;
      if (result.error) throw new Error(result.error);
      setMessage(plan.operation === 'activation' ? 'Combined storage is selected. The relay remains paused. Leave maintenance and start it when ready.'
        : plan.operation === 'adoption' ? 'Existing files and future output locations are accounted for. Review activation next.'
          : plan.operation === 'limit' ? 'Storage limit saved. Existing reservations and files are preserved.'
            : 'Storage budget retained. Review existing files and locations next.');
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Storage update failed.'); }
    finally { if (mounted.current) { clear(); setBusy(false); await refresh().catch(() => setState(null)); } }
  }
  async function cancel() {
    if (!active.current) return; setBusy(true);
    try { const value = await cancelRelayStorage(active.current); if (value.error) setError(value.error); }
    catch { setError('Cancellation was not confirmed. The server expires abandoned reviews automatically.'); }
    finally { if (mounted.current) { clear(); setBusy(false); } }
  }
  const disabled = busy || blocked || !!plan || !state || !maintenanceActive;
  return <section className="relay-section" aria-label="Combined relay storage budget">
    <h4>Combined relay storage budget</h4>
    {state && <RelayStorageStatusView state={state} />}
    {!maintenanceActive && <p>Stop the relay for maintenance to set up or change its storage budget.</p>}
    <button className="btn btn-secondary" type="button" disabled={busy || blocked || !!plan} onClick={() => { void refresh().catch(() => setError('Storage status is unavailable.')); }}>Refresh storage status</button>
    {maintenanceActive && <>
      <label className="form-group" style={{ display: 'block' }}>Total managed limit (MiB)
        <input type="number" min="1" step="1" value={limit} disabled={disabled} onChange={event => setLimit(event.target.value)} />
      </label>
      <p className="text-sm">Allow space for retained files, future writes and interrupted replacements. A lower limit cannot discard existing reservations.</p>
      <div className="history-actions">
        {state?.phase === 'unconfigured' && <button className="btn btn-secondary" disabled={disabled} onClick={() => void review('bootstrap')}>Review new budget</button>}
        {(state?.phase === 'preparing' || state?.phase === 'recovery-required') && <button className="btn btn-secondary" disabled={disabled} onClick={() => void review('bootstrap', true)}>Review interrupted setup</button>}
        {state?.phase === 'preparing' && <>
          <button className="btn btn-secondary" disabled={disabled} onClick={() => void review('adoption')}>Review files and locations</button>
          <button className="btn btn-secondary" disabled={disabled} onClick={() => void review('activation')}>Review storage activation</button>
        </>}
        {state?.phase === 'selected' && <button className="btn btn-secondary" disabled={disabled} onClick={() => void review('limit')}>Review limit change</button>}
      </div>
    </>}
    {plan && <RelayStorageReviewView plan={plan.review} busy={busy} onApply={() => void apply()} onCancel={() => void cancel()} />}
    {busy && <p role="status">Checking storage…</p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error} Existing files remain retained. Refresh status before retrying.</p>}
  </section>;
}
export function RelayStorageStatusView({ state }: { state: RelayStorageStatus }) {
  const labels = { unconfigured: 'No combined budget selected.', preparing: 'Setup is in progress; activation is still required.',
    selected: 'Combined storage accounting is selected.', 'recovery-required': 'Storage accounting could not be verified. Preserve the saved files for recovery.' };
  return <div role="status">
    <p>{labels[state.phase]}</p>
    {state.budget && <p>Limit: {mib(state.budget.limitBytes)} MiB · Reserved: {mib(state.budget.reservedBytes)} MiB · Available for new reservations: {mib(state.budget.availableBytes)} MiB.</p>}
    <p className="text-sm">Reservations include retained files and worst-case writer space. They are not measured disk use or free filesystem space. This covers managed relay outputs; account files and external writers are separate. Storage selection does not confirm network or admission readiness.</p>
  </div>;
}
export function RelayStorageReviewView({ plan, busy, onApply, onCancel }: { plan: RelayStorageReview; busy: boolean; onApply(): void; onCancel(): void }) {
  const fits = !('fits' in plan) || plan.fits;
  return <section aria-label="Review combined storage change">
    <h4>Review storage change</h4>
    {plan.kind === 'desktop-storage-bootstrap-review' && <p>{plan.mode === 'new' ? `Create a ${mib(plan.intent.limitBytes)} MiB managed budget.` : 'Recover the retained budget identity without resetting its ledger or reservations.'}</p>}
    {plan.kind === 'desktop-storage-adoption-review' && <>
      <p>Retained file contents observed: {mib(plan.existing.observedBytes)} MiB. Reservations after adoption: {mib(plan.reservedBytesAfterAdoption)} MiB. Proposed limit: {mib(plan.limit.limitBytes)} MiB.</p>
      <details><summary>Included storage locations</summary><ul>{plan.existing.targets.map(target => <li key={target.path}>{target.path}</li>)}
        {[...(plan.future?.targets ?? []), ...(plan.reusable?.targets ?? [])].map(target => <li key={target.path}>{target.path} (future output)</li>)}</ul></details>
    </>}
    {plan.kind === 'desktop-storage-activation-review' && <p>Save the storage selection and background service settings. Total reserved after preparing the outputs: {mib(plan.budget.reservedBytes)} MiB of {mib(plan.budget.limitBytes)} MiB. The service stays stopped.</p>}
    {plan.kind === 'desktop-storage-limit-review' && <p>Change the limit from {mib(plan.limit.previousLimitBytes)} to {mib(plan.limit.limitBytes)} MiB. Preserve {mib(plan.limit.reservedBytes)} MiB of existing reservations.</p>}
    {!fits && <p role="alert">This selection exceeds the proposed budget. Cancel and review a sufficient limit.</p>}
    <p className="text-sm">Approval expires after one minute. Applying preserves maintenance and existing files. Interrupted changes may require a fresh review.</p>
    <button className="btn btn-primary" type="button" disabled={busy || !fits} onClick={onApply}>Apply reviewed storage change</button>
    <button className="btn btn-secondary" type="button" disabled={busy} onClick={onCancel}>Cancel storage review</button>
  </section>;
}
