import { useEffect, useState } from 'react';
import { getRelayHistoryActivationInput, reviewRelayHistoryActivation, applyRelayHistoryActivation, cancelRelayHistoryOperation,
  type RelayHistoryActivationInput, type AdmissionHistoryActivationReview } from '../api.client';

const empty: RelayHistoryActivationInput = { historyConfigFile: '', enrollmentFile: '', authorityFile: '', policyFile: '', storageKeyFile: '', historyDirectory: '', linksFile: '', operatorTransportFile: '' };
const labels: Array<[keyof RelayHistoryActivationInput, string, boolean?]> = [
  ['historyConfigFile', 'Owner configuration file'], ['enrollmentFile', 'Independent enrollment backup'],
  ['authorityFile', 'Community authority file'], ['policyFile', 'Signed community policy file'],
  ['storageKeyFile', 'History encryption key file'], ['historyDirectory', 'Prepared or recovered history folder'],
  ['linksFile', 'Relay routing file', true], ['operatorTransportFile', 'Recovery connection file', true],
];

export default function HistoryActivation({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [input, setInput] = useState<RelayHistoryActivationInput>(empty), [plan, setPlan] = useState<AdmissionHistoryActivationReview | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    void getRelayHistoryActivationInput().then(result => {
      if (!current) return;
      if (result.error) setError(result.error); else if (result.input) setInput(result.input);
      setLoading(false);
    });
    return () => { current = false; };
  }, []);
  async function run(apply: boolean) {
    setBusy(true); onBusyChange(true); setError(''); setMessage('');
    try {
      if (apply) {
        if (!plan) throw new Error('Review this selection first');
        const result = await applyRelayHistoryActivation(input, plan.approvalDigest); setPlan(null);
        if (result.error) setError(result.error);
        else setMessage('Owner policy and service settings saved. The relay remains paused. Leave maintenance, then start it explicitly; startup checks current copies again.');
      } else {
        setPlan(null); const result = await reviewRelayHistoryActivation(input);
        if (result.error) setError(result.error); else setPlan(result);
      }
    } catch (cause) { setPlan(null); setError(cause instanceof Error ? cause.message : 'History activation failed'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <section className="relay-section history-activation" aria-label="Activate prepared owner history">
    <h4>Activate prepared owner history</h4>
    <p className="text-sm">Choose the files retained during preparation or recovery. Enter their full local paths; key contents stay out of this form.</p>
    <form onSubmit={event => { event.preventDefault(); void run(false); }}>
      {labels.map(([field, label, optional]) => <label key={field} className="form-group" style={{ display: 'block' }}>
        {label}{optional ? ' (optional)' : ''}
        <input type="text" value={input[field]} required={!optional} disabled={busy || loading} autoComplete="off" spellCheck={false}
          onChange={event => { setInput({ ...input, [field]: event.target.value }); setPlan(null); setMessage(''); }} style={{ width: '100%' }} />
      </label>)}
      <p className="text-sm">For relays reached through outbound connections, supply both routing and recovery connection files. An empty recovery connection field uses the pinned direct endpoints.</p>
      <button className="btn btn-secondary" type="submit" disabled={busy || loading}>Review activation</button>
    </form>
    {plan && <HistoryActivationReview plan={plan} busy={busy} onApply={() => void run(true)} onCancel={() => setPlan(null)} />}
    {busy && <div role="status"><p>Checking owner history…</p><button className="btn btn-secondary" type="button" onClick={() => {
      void cancelRelayHistoryOperation().then(result => { if (result.error) setError(result.error); });
    }}>Cancel operation</button><p className="text-sm">Cancellation keeps maintenance active and retains any completed preparation.</p></div>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}

export function HistoryActivationReview({ plan, busy, onApply, onCancel }: {
  plan: AdmissionHistoryActivationReview; busy: boolean; onApply: () => void; onCancel: () => void;
}) {
  const actions = { create: 'Create the owner policy store', resume: 'Finish the interrupted owner policy preparation', update: 'Install the reviewed policy update', retain: 'Retain the installed policy' };
  return <section className="history-activation-review" aria-label="Review owner activation">
    <h4>Review owner activation</h4>
    <p style={{ overflowWrap: 'anywhere' }}>History folder: {plan.historyDirectory}</p>
    <p>{plan.spends} retained spends · {plan.permanentDenials} permanent denials · generation {plan.generation}</p>
    <p>{actions[plan.policyAction]} (revision {plan.policyRevision}) and permanently bind it to this protected history.</p>
    <p style={{ overflowWrap: 'anywhere' }}>History identity: {plan.contextId}</p>
    <p className="text-sm">Review is offline. Applying will require four current durable copies, then save the service selection. It leaves the relay paused and keeps prior history files.</p>
    <p className="text-sm">Witness and coordinator roles still require their own retained state. This action does not initialize those roles.</p>
    <div className="history-actions">
      <button className="btn btn-primary" type="button" disabled={busy} onClick={onApply}>Approve and configure owner</button>
      <button className="btn btn-secondary" type="button" disabled={busy} onClick={onCancel}>Cancel review</button>
    </div>
  </section>;
}
