import { useEffect, useState } from 'react';
import { getRelayHistoryCollectionInput, reviewRelayHistoryCollection, applyRelayHistoryCollection, cancelRelayHistoryOperation,
  type RelayHistoryCollectionReview } from '../api.client';

export default function HistoryCollectionActivation({ onBusyChange, blocked = false }: { onBusyChange: (busy: boolean) => void; blocked?: boolean }) {
  const [configurationFile, setConfigurationFile] = useState(''), [plan, setPlan] = useState<RelayHistoryCollectionReview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  useEffect(() => { let live = true;
    void getRelayHistoryCollectionInput().then(value => { if (live) { if (value.error) setError(value.error); else if (value.input) setConfigurationFile(value.input.configurationFile); } });
    return () => { live = false; };
  }, []);
  async function run(apply: boolean) {
    const digest = plan?.approvalDigest; setBusy(true); onBusyChange(true); setPlan(null); setError(''); setDone(false);
    try {
      if (apply && digest) { const result = await applyRelayHistoryCollection({ configurationFile }, digest); if (result.error) setError(result.error); else setDone(true); }
      else { const result = await reviewRelayHistoryCollection({ configurationFile }); if (result.error) setError(result.error); else setPlan(result); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Collection selection failed'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <section className="relay-section" aria-label="Host several histories">
    <h4>Host several histories</h4>
    <p className="text-sm">Select a collection configuration for histories already enrolled on this device. Review every history and its authorized connections before saving. Existing histories must remain included.</p>
    <form onSubmit={event => { event.preventDefault(); void run(false); }}>
      <label className="form-group" style={{ display: 'block' }}>Existing collection configuration file
        <input type="text" required disabled={blocked || busy} autoComplete="off" spellCheck={false} value={configurationFile}
          onChange={event => { setConfigurationFile(event.target.value); setPlan(null); setDone(false); setError(''); }} />
      </label>
      <button className="btn btn-secondary" type="submit" disabled={blocked || busy}>Review history collection</button>
    </form>
    {plan && <HistoryCollectionReview plan={plan} busy={blocked || busy} onApply={() => void run(true)} />}
    {done && <p role="status">Collection selected. The relay remains paused. Leave maintenance and start the relay explicitly when ready.</p>}
    {busy && <p role="status">Checking retained histories… <button type="button" className="btn btn-secondary" onClick={() => { void cancelRelayHistoryOperation(); }}>Cancel operation</button></p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
export function HistoryCollectionReview({ plan, busy, onApply }: { plan: RelayHistoryCollectionReview; busy: boolean; onApply: () => void }) {
  return <section className="history-activation-review" aria-label="Review history collection">
    <h4>Review history collection</h4>
    <p>{plan.histories.length} independent histories · {plan.health.generations} / {plan.health.maximumGenerations} total generations · {plan.health.retainedBlocks} retained blocks.</p>
    <p className="text-sm">Accounted allocation: {(plan.health.reservedBytes / 1048576).toFixed(2)} MiB. These counters do not include all temporary files or total disk usage.</p>
    <ul>{plan.histories.map(history => <li key={history.contextId} style={{ overflowWrap: 'anywhere' }}>
      {history.directory}<br />Context: {history.contextId}<br />Genesis: {history.genesisId}<br />Volunteer: {history.member}
    </li>)}</ul>
    <p>Shared authorized connections:</p>
    <ul>{plan.controllers.map(controller => <li key={controller.relayId} style={{ overflowWrap: 'anywhere' }}>{controller.relayId} · {controller.endpoint}</li>)}</ul>
    <p className="text-sm">Review checks local history and makes no peer requests. Ordinary reopen may finish an unactivated empty successor slot. Saving does not establish current remote copies or start the service.</p>
    <button type="button" className="btn btn-primary" disabled={busy} onClick={onApply}>Approve collection selection</button>
  </section>;
}
