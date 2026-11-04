import { useEffect, useState } from 'react';
import { cancelRelayHistoryOperation, getRelayPolicyObserverSetupInput, runRelayPolicyObserverSetup,
  type RelayPolicyObserverSetupInput, type RelayPolicyObserverSetupResult } from '../api.client';

type Role = RelayPolicyObserverSetupInput['role'];
const labels = {
  prepare: 'Prepare a new observer', 'export-prepared': 'Re-export its original preparation',
  'enrollment-export': 'Export public volunteer enrollment', enroll: 'Enroll a volunteer',
  'resume-enrollment': 'Resume interrupted volunteer enrollment', initialize: 'Initialize the prepared observer',
} satisfies Record<Role, string>;
const fields: Record<Role, Array<[string, string]>> = {
  prepare: [['setupFile', 'Community setup file'], ['output', 'New observer configuration file']],
  'export-prepared': [['setupFile', 'Original community setup file'], ['output', 'New configuration export file']],
  'enrollment-export': [['configurationFile', 'Prepared observer configuration file'], ['output', 'New public enrollment file']],
  enroll: [['enrollmentFile', 'Public enrollment file'], ['signingKeyFile', 'This volunteer’s signing key file'], ['storageKeyFile', 'This volunteer’s storage key file'], ['directory', 'Dedicated volunteer history folder']],
  'resume-enrollment': [['enrollmentFile', 'Original public enrollment file'], ['signingKeyFile', 'Original volunteer signing key file'], ['storageKeyFile', 'Original storage key file'], ['directory', 'Existing volunteer history folder']],
  initialize: [['configurationFile', 'Prepared observer configuration file'], ['operatorTransportFile', 'Pinned maintenance routing file (optional)']],
};
const blank = (role: Role) => ({ role, ...Object.fromEntries(fields[role].map(([name]) => [name, ''])) }) as RelayPolicyObserverSetupInput;
export default function PolicyObserverSetup({ blocked = false, onBusyChange }: { blocked?: boolean; onBusyChange: (busy: boolean) => void }) {
  const [input, setInput] = useState<RelayPolicyObserverSetupInput>(blank('prepare'));
  const [result, setResult] = useState<RelayPolicyObserverSetupResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let live = true;
    void getRelayPolicyObserverSetupInput().then(value => { if (live) { if (value.error) setError(value.error); else if (value.input) setInput(value.input); } });
    return () => { live = false; };
  }, []);
  function change(next: RelayPolicyObserverSetupInput) { setInput(next); setResult(null); setError(''); }
  async function run(apply: boolean) {
    const digest = result?.approvalDigest; setResult(null); setError(''); setBusy(true); onBusyChange(true);
    try {
      const value = await runRelayPolicyObserverSetup(apply ? 'apply' : 'review', input, apply ? digest : undefined);
      if (value.error) setError(value.error); else { setInput(value.input); setResult(value.result); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Observer setup failed; retain its files'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <section className="relay-section" aria-label="Prepare policy observer history">
    <h4>Prepare policy observer history</h4>
    <p className="text-sm">Agree on the community authority and five volunteer keys first. Prepare one original history, share its public enrollment,
      enroll the volunteers, then initialize the observer after at least four copies are reachable.</p>
    <form onSubmit={event => { event.preventDefault(); void run(false); }}>
      <label className="form-group" style={{ display: 'block' }}>Setup operation
        <select value={input.role} disabled={blocked || busy} onChange={event => change(blank(event.target.value as Role))}>
          {Object.entries(labels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
        </select>
      </label>
      {fields[input.role].map(([name, label]) => <label key={name} className="form-group" style={{ display: 'block' }}>{label}
        <input type="text" required={name !== 'operatorTransportFile'} disabled={blocked || busy} autoComplete="off" spellCheck={false}
          value={(input as unknown as Record<string, string>)[name]} onChange={event => change({ ...input, [name]: event.target.value } as RelayPolicyObserverSetupInput)} />
      </label>)}
      {input.role === 'prepare' && <p className="text-sm">Use an unused observer key. Preparation retains the original encrypted history beside that key.
        If output is interrupted, keep those files and re-export the same preparation.</p>}
      {input.role === 'initialize' && <p className="text-sm">Initialization checks four copies of the original history. With no maintenance routing file,
        it uses the five direct endpoints in the configuration.</p>}
      {input.role === 'enrollment-export' && <p className="text-sm">The enrollment file contains public pins and encrypted initial history. It contains no private keys or local paths.</p>}
      <button type="submit" className="btn btn-secondary" disabled={blocked || busy}>Review observer setup</button>
    </form>
    {result?.approvalDigest && <section aria-label="Review observer setup">
      <h4>{labels[input.role]}</h4>
      <dl style={{ overflowWrap: 'anywhere' }}>
        {result.directory && <><dt>History folder</dt><dd>{result.directory}</dd></>}
        {result.output && <><dt>New output file</dt><dd>{result.output}</dd></>}
        {result.anchor && <><dt>Retained original preparation</dt><dd>{result.anchor}</dd></>}
        {result.owner && <><dt>Observer key</dt><dd>{result.owner}</dd></>}
        {result.member && <><dt>Volunteer key</dt><dd>{result.member}</dd></>}
        {result.contextId && <><dt>History context</dt><dd>{result.contextId}</dd></>}
        {result.genesisId && <><dt>Original history</dt><dd>{result.genesisId}</dd></>}
      </dl>
      {result.members && <ul>{result.members.map(member => <li key={member.publicKey} style={{ overflowWrap: 'anywhere' }}>{member.publicKey} · {member.endpoint}</li>)}</ul>}
      <p className="text-sm">Approval applies only this operation. The relay stays paused. Existing histories and keys must be retained.</p>
      <button type="button" className="btn btn-primary" disabled={blocked || busy} onClick={() => void run(true)}>Approve observer setup</button>
    </section>}
    {result && !result.approvalDigest && <p role="status">Operation completed. The relay remains paused; select its prepared observer or volunteer configuration separately.</p>}
    {busy && <p role="status">Working on observer setup… <button type="button" className="btn btn-secondary" onClick={() => { void cancelRelayHistoryOperation(); }}>Cancel operation</button></p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
