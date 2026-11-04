import { useEffect, useState } from 'react';
import { getRelayVolunteerActivationInput, reviewRelayVolunteerActivation, applyRelayVolunteerActivation, cancelRelayHistoryOperation,
  type RelayVolunteerActivationInput, type RelayVolunteerActivationReview } from '../api.client';
const empty: RelayVolunteerActivationInput = { enrollmentFile: '', signingKeyFile: '', storageKeyFile: '', directory: '', controllersFile: '', output: '',
  generationMiB: 64, blocksPerGeneration: 10001, maximumGenerations: 65 };
const paths = [['enrollmentFile', 'Independently retained enrollment file'], ['signingKeyFile', 'Volunteer signing key file'], ['storageKeyFile', 'Local storage key file'],
  ['directory', 'Enrolled volunteer history folder'], ['controllersFile', 'Authorized owner connection file'], ['output', 'New volunteer service configuration file']] as const;
export default function HistoryVolunteerActivation({ onBusyChange, blocked = false }: { onBusyChange: (busy: boolean) => void; blocked?: boolean }) {
  const [input, setInput] = useState<RelayVolunteerActivationInput>(empty), [plan, setPlan] = useState<RelayVolunteerActivationReview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  useEffect(() => { let active = true;
    void getRelayVolunteerActivationInput().then(value => { if (active) { if (value.error) setError(value.error); else if (value.input) setInput(value.input); } });
    return () => { active = false; };
  }, []);
  function changed(next: RelayVolunteerActivationInput) { setInput(next); setPlan(null); setError(''); setDone(false); }
  async function run(apply: boolean) {
    const approval = plan?.approvalDigest; setBusy(true); onBusyChange(true); setPlan(null); setError(''); setDone(false);
    try {
      if (apply && approval) { const result = await applyRelayVolunteerActivation(input, approval); if (result.error) setError(result.error); else setDone(true); }
      else { const result = await reviewRelayVolunteerActivation(input); if (result.error) setError(result.error); else setPlan(result); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Volunteer activation failed'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  const disabled = blocked || busy;
  return <section className="relay-section" aria-label="Activate enrolled volunteer">
    <h4>Activate enrolled volunteer</h4>
    <p className="text-sm">Select an existing enrollment and its retained history. Verify the owner connections independently. Choose a new configuration output; existing files are preserved.</p>
    <form onSubmit={event => { event.preventDefault(); void run(false); }}>
      {paths.map(([field, label]) => <label className="form-group" style={{ display: 'block' }} key={field}>{label}
        <input type="text" required disabled={disabled} value={input[field]} autoComplete="off" spellCheck={false} onChange={event => changed({ ...input, [field]: event.target.value })} />
      </label>)}
      {([['generationMiB', 'Storage per generation (MiB)', 5, 256], ['blocksPerGeneration', 'Blocks per generation', 1, 10001], ['maximumGenerations', 'Retained generations', 1, 65]] as const)
        .map(([field, label, min, max]) => <label className="form-group" style={{ display: 'block' }} key={field}>{label}
          <input type="number" required min={min} max={max} step={1} disabled={disabled} value={input[field]} onChange={event => changed({ ...input, [field]: Number(event.target.value) })} />
        </label>)}
      <p className="text-sm">Limits must preserve existing records. They do not include all journals, temporary files or filesystem overhead.</p>
      <button className="btn btn-secondary" type="submit" disabled={disabled}>Review volunteer activation</button>
    </form>
    {plan && <HistoryVolunteerActivationReview plan={plan} busy={disabled} onApply={() => void run(true)} />}
    {done && <p role="status">Volunteer configuration saved. The relay remains paused. Leave maintenance and start the relay explicitly when ready.</p>}
    {busy && <p role="status">Checking retained volunteer history… <button className="btn btn-secondary" type="button" onClick={() => { void cancelRelayHistoryOperation(); }}>Cancel operation</button></p>}
    {error && <div role="alert"><p>{error}</p><p className="text-sm">Keep all existing history and configuration files. A failed settings save may leave a valid new configuration file; review another output path to save the selection. Missing accepted history requires recovery.</p></div>}
  </section>;
}
export function HistoryVolunteerActivationReview({ plan, busy, onApply }: { plan: RelayVolunteerActivationReview; busy: boolean; onApply: () => void }) {
  return <section className="history-activation-review" aria-label="Review volunteer service">
    <h4>Review volunteer service</h4>
    <p style={{ overflowWrap: 'anywhere' }}>History context: {plan.contextId}<br />Genesis: {plan.genesisId}<br />This volunteer: {plan.member}</p>
    <p style={{ overflowWrap: 'anywhere' }}>Retained history: {plan.directory}<br />New service configuration: {plan.output}</p>
    <p>{plan.health.generations} retained generations · {plan.health.retainedBlocks} retained blocks · {(plan.health.reservedBytes / 1048576).toFixed(2)} MiB accounted storage.</p>
    <p>Limits: {plan.health.maximumGenerationBytes / 1048576} MiB and {plan.health.maximumGenerationBlocks} blocks per generation, up to {plan.health.maximumGenerations} generations.</p>
    <p>Authorized outbound connections:</p><ul>{plan.controllers.map(controller => <li key={controller.relayId} style={{ overflowWrap: 'anywhere' }}>{controller.relayId} · {controller.endpoint}</li>)}</ul>
    <p className="text-sm">Review reopens and validates retained history without contacting peers. As on ordinary startup, it can finish an unactivated empty successor slot. It cannot enroll a missing genesis or recreate missing accepted records.</p>
    <p>Approval saves this configuration while keeping the relay paused. It does not establish live reachability or a current quorum.</p>
    <button className="btn btn-primary" type="button" disabled={busy} onClick={onApply}>Approve volunteer configuration</button>
  </section>;
}
