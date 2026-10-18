import { useEffect, useState } from 'react';
import { getRelayPolicyObserverInput, reviewRelayPolicyObserver, applyRelayPolicyObserver, cancelRelayHistoryOperation,
  type RelayPolicyObserverInput, type RelayPolicyObserverReview } from '../api.client';

export default function PolicyObserverActivation({ onBusyChange, blocked = false }: { onBusyChange: (busy: boolean) => void; blocked?: boolean }) {
  const [input, setInput] = useState<RelayPolicyObserverInput>({ configurationFile: '', linksFile: '' });
  const [plan, setPlan] = useState<RelayPolicyObserverReview | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [done, setDone] = useState(false);
  useEffect(() => { let live = true;
    void getRelayPolicyObserverInput().then(value => { if (live) { if (value.error) setError(value.error); else if (value.input) setInput(value.input); } });
    return () => { live = false; };
  }, []);
  async function run(apply: boolean) {
    const digest = plan?.approvalDigest; setBusy(true); onBusyChange(true); setPlan(null); setError(''); setDone(false);
    try {
      if (apply && digest) { const value = await applyRelayPolicyObserver(input, digest); if (value.error) setError(value.error); else setDone(true); }
      else { const value = await reviewRelayPolicyObserver(input); if (value.error) setError(value.error); else setPlan(value); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Observer selection failed'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  function change(field: keyof RelayPolicyObserverInput, value: string) {
    setInput(previous => ({ ...previous, [field]: value })); setPlan(null); setError(''); setDone(false);
  }
  return <section className="relay-section" aria-label="Select a policy observer">
    <h4>Experimental policy observer</h4>
    <p className="text-sm">Select an observer already prepared for this community. It retains policy updates and conflicting signatures so restored devices cannot silently return to older rules.</p>
    <form onSubmit={event => { event.preventDefault(); void run(false); }}>
      <label className="form-group" style={{ display: 'block' }}>Prepared observer configuration file
        <input type="text" required value={input.configurationFile} disabled={blocked || busy} autoComplete="off" spellCheck={false} onChange={event => change('configurationFile', event.target.value)} />
      </label>
      <label className="form-group" style={{ display: 'block' }}>Pinned relay routing file (optional)
        <input type="text" value={input.linksFile} disabled={blocked || busy} autoComplete="off" spellCheck={false} onChange={event => change('linksFile', event.target.value)} />
      </label>
      <p className="text-sm">With no routing file, the observer uses the five direct endpoints in its configuration. Initial setup and lost-state recovery currently use the Node operator commands.</p>
      <button type="submit" className="btn btn-secondary" disabled={blocked || busy}>Review observer selection</button>
    </form>
    {plan && <section className="history-activation-review" aria-label="Review policy observer">
      <h4>Review policy observer</h4>
      <p>Retained policy revision {plan.head.revision} · history generation {plan.generation} · {plan.pending ? 'pending replication' : 'no pending write'}.</p>
      <p>Policy expiry: {new Date(plan.policyExpiresAt).toLocaleString()}.</p>
      <dl style={{ overflowWrap: 'anywhere' }}>
        <dt>History folder</dt><dd>{plan.directory}</dd><dt>Community authority</dt><dd>{plan.authority}</dd>
        <dt>Observer key</dt><dd>{plan.owner}</dd><dt>Original history</dt><dd>{plan.genesisId}</dd>
      </dl>
      <p>Selected history volunteers:</p>
      <ul>{plan.members.map(member => <li key={member.publicKey} style={{ overflowWrap: 'anywhere' }}>{member.publicKey} · {plan.routing
        ? plan.routing.find(route => route.publicKey === member.publicKey)?.relayId : member.endpoint}
        {plan.routing?.find(route => route.publicKey === member.publicKey)?.viaRelayId && <> · bridge {plan.routing.find(route => route.publicKey === member.publicKey)?.viaRelayId}</>}
      </li>)}</ul>
      {plan.fenced && <p role="alert">This location was permanently retired by recovery and cannot be activated. Retain it and use the independently reviewed restoration.</p>}
      {plan.blocked && <p role="alert">Conflicting signed policies are retained. This observer cannot certify a current policy. Recovery preserves that conflict.</p>}
      {!plan.policyCurrent && <p role="alert">The retained policy is outside its validity period. Import a valid signed successor before activation.</p>}
      <p className="text-sm">This checks local evidence only. Saving leaves the relay paused; a later start must confirm four current history copies before the observer can answer.</p>
      <button type="button" className="btn btn-primary" disabled={blocked || busy || plan.fenced || plan.blocked || !plan.policyCurrent} onClick={() => void run(true)}>Approve observer selection</button>
    </section>}
    {done && <p role="status">Observer selected. Leave maintenance and start the relay explicitly when ready.</p>}
    {busy && <p role="status">Checking observer history… <button type="button" className="btn btn-secondary" onClick={() => { void cancelRelayHistoryOperation(); }}>Cancel operation</button></p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
