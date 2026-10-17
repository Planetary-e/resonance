import { useEffect, useState } from 'react';
import { getRelayHistorySetupInput, runRelayHistorySetup, cancelRelayHistoryOperation, type RelayHistorySetupInput, type RelayHistorySetupResult } from '../api.client';

const empty = (role: RelayHistorySetupInput['role']): RelayHistorySetupInput => role === 'configuration'
  ? { role, ownerKeyFile: '', authorityFile: '', policyFile: '', membersFile: '', output: '', historyId: '' }
  : role === 'owner' ? { role, historyConfigFile: '', policyFile: '', storageKeyFile: '', directory: '', output: '', mode: 'new' }
    : role === 'volunteer' ? { role, enrollmentFile: '', signingKeyFile: '', storageKeyFile: '', directory: '' }
      : { role, historyConfigFile: '', enrollmentFile: '', policyFile: '', storageKeyFile: '', directory: '', operatorTransportFile: '' };
const labels: Record<string, string> = { ownerKeyFile: 'Owner signing key file', authorityFile: 'Pinned community authority file', policyFile: 'Current signed policy file',
  membersFile: 'Five verified volunteer contacts file', output: 'New output file', historyConfigFile: 'Owner configuration file', storageKeyFile: 'Local storage key file',
  directory: 'Dedicated history folder', enrollmentFile: 'Independently retained enrollment file', signingKeyFile: 'Volunteer signing key file', operatorTransportFile: 'Owner connection file (optional)' };
export default function HistorySetup({ onBusyChange, blocked = false }: { onBusyChange: (busy: boolean) => void; blocked?: boolean }) {
  const [input, setInput] = useState<RelayHistorySetupInput>(empty('configuration')), [result, setResult] = useState<RelayHistorySetupResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void getRelayHistorySetupInput().then(value => { if (active) { if (value.error) setError(value.error); else if (value.input) setInput(value.input); } });
    return () => { active = false; };
  }, []);
  function changed(value: RelayHistorySetupInput) { setInput(value); setResult(null); setError(''); }
  async function run(action: 'review' | 'apply') {
    setBusy(true); onBusyChange(true); setError('');
    const approval = action === 'apply' ? result?.approvalDigest : undefined; setResult(null);
    try {
      const response = await runRelayHistorySetup(action, input, approval);
      if (response.error) setError(response.error); else { setInput(response.input); setResult(response.result); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'History setup failed'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  const disabled = busy || blocked;
  return <section className="relay-section" aria-label="Prepare protected history">
    <h4>Prepare protected history</h4>
    <p className="text-sm">For a new owner, create its configuration, prepare its history and share the enrollment file with five volunteers. Verify their public keys independently. Each volunteer enrolls on their own device with their own private keys. Keep independent backups of the owner configuration, enrollment and keys.</p>
    <form onSubmit={event => { event.preventDefault(); void run('review'); }}>
      <label className="form-group" style={{ display: 'block' }}>Operation
        <select value={input.role} disabled={disabled} onChange={event => changed(empty(event.target.value as RelayHistorySetupInput['role']))}>
          <option value="configuration">Create owner configuration</option><option value="owner">Prepare or export owner history</option>
          <option value="volunteer">Enroll this volunteer</option><option value="readiness">Complete initial owner readiness</option>
        </select>
      </label>
      {input.role === 'owner' && <label className="form-group" style={{ display: 'block' }}>Preparation
        <select value={input.mode} disabled={disabled} onChange={event => changed({ ...input, mode: event.target.value as 'new' | 'resume' | 'export' })}>
          <option value="new">New empty history</option><option value="resume">Resume interrupted initial preparation</option><option value="export">Export retained initial enrollment</option>
        </select>
      </label>}
      {Object.entries(input).filter(([field]) => field in labels).map(([field, value]) => <label className="form-group" style={{ display: 'block' }} key={field}>
        {field === 'output' ? input.role === 'configuration' ? 'New owner configuration file' : 'New enrollment backup file' : labels[field]}
        <input type="text" value={value} required={field !== 'operatorTransportFile'} disabled={disabled} autoComplete="off" spellCheck={false}
          onChange={event => changed({ ...input, [field]: event.target.value })} />
      </label>)}
      <p className="text-sm">Enter absolute local paths. Private keys stay in files. Setup keeps the relay paused and does not install a service. Existing files are preserved.</p>
      <button className="btn btn-secondary" disabled={disabled} type="submit">Review setup</button>
    </form>
    {result && <HistorySetupReview result={result} busy={disabled} onApply={() => void run('apply')} />}
    {result?.result === 'new-owner-configuration' && input.role === 'configuration' && <button className="btn btn-secondary" disabled={disabled}
      onClick={() => changed({ role: 'owner', historyConfigFile: input.output, policyFile: input.policyFile, storageKeyFile: '', directory: '', output: '', mode: 'new' })}>Prepare this owner history</button>}
    {result?.result === 'enrollment-exported' && input.role === 'owner' && <button className="btn btn-secondary" disabled={disabled}
      onClick={() => changed({ role: 'readiness', historyConfigFile: input.historyConfigFile, enrollmentFile: input.output, policyFile: input.policyFile,
        storageKeyFile: input.storageKeyFile, directory: input.directory, operatorTransportFile: '' })}>Review readiness after volunteers enroll</button>}
    {busy && <div role="status"><p>History operation in progress…</p><button className="btn btn-secondary" type="button"
      onClick={() => { void cancelRelayHistoryOperation().then(response => { if (response.error) setError(response.error); }); }}>Cancel operation</button></div>}
    {error && <div role="alert"><p>{error}</p><p className="text-sm">Keep any created files. If owner setup published a baseline, review resumption with the same configuration and a new export path. Use recovery for a lost accepted history. An interrupted volunteer enrollment must be inspected before retrying; do not clear its directory.</p></div>}
  </section>;
}

export function HistorySetupReview({ result, busy, onApply }: { result: RelayHistorySetupResult; busy: boolean; onApply: () => void }) {
  if (!result.approvalDigest) return <div role="status">
    <p>{result.result === 'history-ready' ? 'Initial history has four fresh copies. Review owner activation next; the relay remains paused.'
      : result.result === 'enrolled' ? 'Volunteer history enrolled. Use Activate enrolled volunteer to review its owner connections before starting the background relay.'
        : result.result === 'new-owner-configuration' ? 'Owner configuration saved. Prepare its dedicated history next.' : 'Enrollment exported. Keep an independent backup and provide it to the five pinned volunteers.'}</p>
    {result.genesisId && <p style={{ overflowWrap: 'anywhere' }}>Genesis fingerprint: {result.genesisId}</p>}
  </div>;
  const readiness = result.kind === 'admission-initial-readiness';
  return <section className="history-activation-review" aria-label="Review initial history setup">
    <h4>{readiness ? 'Review initial readiness' : result.kind === 'history-volunteer-enrollment' ? 'Review volunteer enrollment' : 'Review owner setup'}</h4>
    <p style={{ overflowWrap: 'anywhere' }}>History context: {result.contextId}</p>
    {result.genesisId && <p style={{ overflowWrap: 'anywhere' }}>Genesis fingerprint: {result.genesisId}</p>}
    {result.owner && <p style={{ overflowWrap: 'anywhere' }}>Owner public key: {result.owner}</p>}
    {result.authority && <p style={{ overflowWrap: 'anywhere' }}>Community authority: {result.authority}</p>}
    {result.member && <p style={{ overflowWrap: 'anywhere' }}>This volunteer: {result.member}</p>}
    {result.members && <ul>{result.members.map(member => <li key={member.publicKey} style={{ overflowWrap: 'anywhere' }}>{member.publicKey} · {member.endpoint}</li>)}</ul>}
    {result.directory && <p style={{ overflowWrap: 'anywhere' }}>History folder: {result.directory}</p>}
    {result.output && <p style={{ overflowWrap: 'anywhere' }}>New output: {result.output}</p>}
    {result.spends !== undefined && <p>{result.spends} retained spends · {result.permanentDenials} permanent denials.</p>}
    {result.maximumGenerations && <p className="text-sm">Up to {result.maximumGenerations} generations; {Math.round(result.generationByteLimit! / 1048576)} MiB per generation, {Math.round(result.ancestryByteLimit! / 1048576)} MiB ancestry accounting. Journals and filesystem overhead are additional.</p>}
    <p>{readiness ? 'Approval completes retained initial work and requires four fresh copies before activation. It does not start the relay.'
      : 'This review is offline. Approval creates only the selected setup files; it does not establish four-copy readiness or start the relay.'}</p>
    {(result.initializeWriter || result.initializeArchive) && <p className="text-sm">Approval includes only pristine writer/archive preparation. Missing committed history cannot be recreated.</p>}
    <button className="btn btn-primary" type="button" disabled={busy} onClick={onApply}>{readiness ? 'Approve initial readiness' : 'Approve setup'}</button>
  </section>;
}
