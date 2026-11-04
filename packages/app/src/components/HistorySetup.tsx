import { useEffect, useState } from 'react';
import { getRelayHistorySetupInput, runRelayHistorySetup, cancelRelayHistoryOperation, type RelayHistorySetupInput, type RelayHistorySetupResult } from '../api.client';

const empty = (role: RelayHistorySetupInput['role']): RelayHistorySetupInput => role === 'configuration'
  ? { role, ownerKeyFile: '', authorityFile: '', policyFile: '', membersFile: '', output: '', historyId: '' }
  : role === 'owner' ? { role, historyConfigFile: '', policyFile: '', storageKeyFile: '', directory: '', output: '', mode: 'new' }
    : role === 'owner-limits' ? { role, historyConfigFile: '', enrollmentFile: '', policyFile: '', storageKeyFile: '', directory: '', output: '', archiveMiB: 64, archiveBlocks: 10001 }
    : role === 'admission-role-capture' ? { role, historyConfigFile: '', policyFile: '', storageKeyFile: '', directory: '', localRoleDirectory: '', selection: 'both', operatorTransportFile: '' }
    : role === 'admission-role-setup' ? { role, storageKeyFile: '', directory: '', output: '', mode: 'new', selection: 'witness' }
    : role === 'admission-role-key-export' ? { role, historyConfigFile: '', policyFile: '', storageKeyFile: '', directory: '', localRoleDirectory: '', selection: 'witness', output: '', operatorTransportFile: '' }
    : (role === 'volunteer' || role === 'volunteer-resume') ? { role, enrollmentFile: '', signingKeyFile: '', storageKeyFile: '', directory: '' }
      : { role, historyConfigFile: '', enrollmentFile: '', policyFile: '', storageKeyFile: '', directory: '', operatorTransportFile: '' };
const labels: Record<string, string> = { ownerKeyFile: 'Owner signing key file', authorityFile: 'Pinned community authority file', policyFile: 'Current signed policy file',
  membersFile: 'Five verified volunteer contacts file', output: 'New output file', historyConfigFile: 'Owner configuration file', storageKeyFile: 'Local storage key file',
  directory: 'Dedicated history folder', localRoleDirectory: 'Existing admission role folder', enrollmentFile: 'Independently retained enrollment file', signingKeyFile: 'Volunteer signing key file', operatorTransportFile: 'Owner connection file (optional)' };
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
          <option value="volunteer">Enroll this volunteer</option><option value="volunteer-resume">Resume interrupted volunteer enrollment</option><option value="readiness">Complete initial owner readiness</option><option value="owner-limits">Edit owner archive limits</option>
          <option value="admission-role-capture">Protect existing admission roles</option>
          <option value="admission-role-setup">Prepare a new admission role</option><option value="admission-role-key-export">Export a protected role signing key</option>
        </select>
      </label>
      {input.role === 'owner' && <label className="form-group" style={{ display: 'block' }}>Preparation
        <select value={input.mode} disabled={disabled} onChange={event => changed({ ...input, mode: event.target.value as 'new' | 'resume' | 'export' })}>
          <option value="new">New empty history</option><option value="resume">Resume interrupted initial preparation</option><option value="export">Export retained initial enrollment</option>
        </select>
      </label>}
      {input.role === 'admission-role-capture' && <>
        <label className="form-group" style={{ display: 'block' }}>Existing roles
          <select value={input.selection} disabled={disabled} onChange={event => changed({ ...input, selection: event.target.value as 'witness' | 'coordinator' | 'both' })}>
            <option value="both">Witness and coordinator</option><option value="witness">Witness</option><option value="coordinator">Coordinator</option>
          </select>
        </label>
        <p className="text-sm">Protect the decisions of existing admission roles in this owner's history. Both locations must use the selected storage key and retained signed policy. Keep the original role files: after approval they prevent the old local roles from running independently. Missing decisions require recovery.</p>
      </>}
      {(input.role === 'admission-role-setup' || input.role === 'admission-role-key-export') && <>
        <label className="form-group" style={{ display: 'block' }}>New role
          <select value={input.selection} disabled={disabled} onChange={event => changed({ ...input, selection: event.target.value as 'witness' | 'coordinator' })}>
            <option value="witness">Witness</option><option value="coordinator">Coordinator</option>
          </select>
        </label>
        {input.role === 'admission-role-setup' && <label className="form-group" style={{ display: 'block' }}>Role preparation
          <select value={input.mode} disabled={disabled} onChange={event => changed({ ...input, mode: event.target.value as 'new' | 'resume' })}>
            <option value="new">Generate a new key in a new folder</option><option value="resume">Resume retained preparation</option>
          </select>
        </label>}
        <p className="text-sm">Prepare a new role, enroll its public key in the community's signed policy, then protect its initial history. Export its signing key only after those decisions have four fresh copies. Use recovery for a lost role that has already operated.</p>
      </>}
      {Object.entries(input).filter(([field]) => field in labels).map(([field, value]) => <label className="form-group" style={{ display: 'block' }} key={field}>
        {field === 'output' ? (input.role === 'configuration' || input.role === 'owner-limits') ? 'New owner configuration file'
          : input.role === 'admission-role-setup' ? 'New public key file' : input.role === 'admission-role-key-export' ? 'New private signing key file' : 'New enrollment backup file' : labels[field]}
        <input type="text" value={value} required={field !== 'operatorTransportFile'} disabled={disabled} autoComplete="off" spellCheck={false}
          onChange={event => changed({ ...input, [field]: event.target.value })} />
      </label>)}
      {input.role === 'owner-limits' && <>
        <label className="form-group" style={{ display: 'block' }}>Ciphertext archive per generation (MiB)
          <input type="number" min={1} max={64} step={1} required disabled={disabled} value={input.archiveMiB}
            onChange={event => changed({ ...input, archiveMiB: Number(event.target.value) })} />
        </label>
        <label className="form-group" style={{ display: 'block' }}>Archive blocks per generation
          <input type="number" min={1} max={10001} step={1} required disabled={disabled} value={input.archiveBlocks}
            onChange={event => changed({ ...input, archiveBlocks: Number(event.target.value) })} />
        </label>
        <p className="text-sm">Archive limits must retain accepted and pending ciphertext. They exclude spend images, manifests, recovery workspaces and filesystem overhead. Review activation with the new configuration separately.</p>
      </>}
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
    {error && <div role="alert"><p>{error}</p><p className="text-sm">Keep any created files. If owner setup published a baseline, review resumption with the same configuration and a new export path. Use recovery for a lost accepted history. Use Resume interrupted volunteer enrollment to inspect retained genesis state; do not clear its directory. Missing accepted history needs recovery.</p></div>}
  </section>;
}

export function HistorySetupReview({ result, busy, onApply }: { result: RelayHistorySetupResult; busy: boolean; onApply: () => void }) {
  if (!result.approvalDigest) return <div role="status">
    <p>{result.result === 'owner-limits-configured' ? 'New owner archive configuration saved. Review owner activation using this file; the relay remains paused.'
      : result.result === 'fresh-admission-role-prepared' ? 'New role prepared. Only its public key was exported. Enroll it in signed community policy and protect the role before exporting its signing key.'
      : result.result === 'protected-admission-role-key-exported' ? 'Protected role signing key exported to the selected private file. Keep an independent backup with its storage key and history pins. The relay remains paused.'
      : result.result === 'admission-roles-protected' ? 'Admission role decisions are protected by four fresh copies. The original local roles remain blocked. Review owner activation next; the relay remains paused.'
      : result.result === 'history-ready' ? 'Initial history has four fresh copies. Review owner activation next; the relay remains paused.'
      : (result.result === 'enrolled' || result.result === 'enrollment-resumed') ? 'Volunteer history enrolled. Use Activate enrolled volunteer to review its owner connections before starting the background relay.'
        : result.result === 'new-owner-configuration' ? 'Owner configuration saved. Prepare its dedicated history next.' : 'Enrollment exported. Keep an independent backup and provide it to the five pinned volunteers.'}</p>
    {result.result === 'owner-limits-configured' && <p style={{ overflowWrap: 'anywhere' }}>New configuration: {result.output}</p>}
    {result.genesisId && <p style={{ overflowWrap: 'anywhere' }}>Genesis fingerprint: {result.genesisId}</p>}
    {result.publicKey && <p style={{ overflowWrap: 'anywhere' }}>Role public key: {result.publicKey}</p>}
  </div>;
  const readiness = result.kind === 'admission-initial-readiness';
  const roles = result.kind === 'admission-local-role-capture';
  const fresh = result.kind === 'fresh-admission-role-setup', exporting = result.kind === 'protected-admission-role-key-export';
  return <section className="history-activation-review" aria-label="Review initial history setup">
    <h4>{fresh ? 'Review new role preparation' : exporting ? 'Review protected signing key export' : roles ? 'Review admission role protection' : result.kind === 'owner-history-limits' ? 'Review owner archive limits' : readiness ? 'Review initial readiness' : result.kind?.startsWith('history-volunteer-') ? 'Review volunteer enrollment' : 'Review owner setup'}</h4>
    {result.contextId && <p style={{ overflowWrap: 'anywhere' }}>History context: {result.contextId}</p>}
    {(fresh || exporting) && <p>Role: {result.selection}. {result.publicKey ? <>Public key: <span style={{ overflowWrap: 'anywhere' }}>{result.publicKey}</span></> : 'A new random key will be generated after approval.'}</p>}
    {result.genesisId && <p style={{ overflowWrap: 'anywhere' }}>Genesis fingerprint: {result.genesisId}</p>}
    {result.owner && <p style={{ overflowWrap: 'anywhere' }}>Owner public key: {result.owner}</p>}
    {result.authority && <p style={{ overflowWrap: 'anywhere' }}>Community authority: {result.authority}</p>}
    {result.member && <p style={{ overflowWrap: 'anywhere' }}>This volunteer: {result.member}</p>}
    {result.members && <ul>{result.members.map(member => <li key={member.publicKey} style={{ overflowWrap: 'anywhere' }}>{member.publicKey} · {member.endpoint}</li>)}</ul>}
    {result.directory && <p style={{ overflowWrap: 'anywhere' }}>History folder: {result.directory}</p>}
    {result.output && <p style={{ overflowWrap: 'anywhere' }}>New output: {result.output}</p>}
    {result.spends !== undefined && <p>{result.spends} retained spends · {result.permanentDenials} permanent denials.</p>}
    {roles && <>
      <p>Selected roles: {result.localRoles?.join(', ')}. {result.fencedRoles ?? 0} original roles already blocked.</p>
      <p>{result.witnessVotes ?? 0} witness decisions · {result.coordinatorCertificates ?? 0} coordinator certificates · {(result.witnessDenials ?? 0) + (result.coordinatorDenials ?? 0)} permanent denials.</p>
      {result.alreadyCaptured ? <p>These decisions are already protected. Approval verifies four fresh copies and preserves the local blocks.</p>
        : <p>Capture and the next complete checkpoint need {result.requiredBlocks} blocks and {((result.requiredCiphertextBytes ?? 0) / 1048576).toFixed(2)} MiB of ciphertext capacity. Available: {result.availableBlocks} blocks and {((result.availableCiphertextBytes ?? 0) / 1048576).toFixed(2)} MiB.</p>}
      {result.fits === false && <p role="alert">There is insufficient archive space. Review capacity or complete history maintenance before protecting these roles.</p>}
    </>}
    {result.maximumGenerations && <p className="text-sm">Up to {result.maximumGenerations} generations; {Math.round(result.generationByteLimit! / 1048576)} MiB per generation, {Math.round(result.ancestryByteLimit! / 1048576)} MiB ancestry accounting. Journals and filesystem overhead are additional.</p>}
    {result.kind === 'owner-history-limits' && <p>{result.retainedBlocks} retained archive blocks · {((result.retainedCiphertextBytes ?? 0) / 1048576).toFixed(2)} MiB ciphertext. New limits: {(result.archiveBytes ?? 0) / 1048576} MiB and {result.archiveBlocks} blocks per generation. Pending ciphertext is preserved.</p>}
    {result.phase && !fresh && <p>{result.phase === 'genesis-pending' ? 'The first history block was not fully saved. Approval finishes the original enrollment.' : `${result.retainedBlocks} existing blocks remain retained.`}</p>}
    {result.kind === 'history-volunteer-resumption' && <p>Resume the same pinned genesis only. A missing or corrupt manifest cannot be recreated. Existing accepted records remain retained; the relay stays paused.</p>}
    <p>{fresh ? 'Approval prepares an empty history for a genuinely new key and exports only its public key. Its signing key stays encrypted until protected enrollment. Missing prepared history cannot be reset.'
      : exporting ? 'Approval requires four fresh copies and the retained local block before writing the private signing key. The relay remains paused. Keep the role history and independently back up the exported key.'
      : roles ? 'This review is offline. Approval blocks the original local roles before saving their decisions on four volunteers. Keep all files if interrupted and review again. The relay remains paused.'
      : readiness ? 'Approval completes retained initial work and requires four fresh copies before activation. It does not start the relay.'
      : 'This review is offline. Approval creates only the selected setup files; it does not establish four-copy readiness or start the relay.'}</p>
    {(result.initializeWriter || result.initializeArchive) && <p className="text-sm">Approval includes only pristine writer/archive preparation. Missing committed history cannot be recreated.</p>}
    <button className="btn btn-primary" type="button" disabled={busy || (roles && result.fits === false)} onClick={onApply}>{fresh ? 'Approve new role preparation' : exporting ? 'Approve signing key export' : roles ? 'Approve role protection' : readiness ? 'Approve initial readiness' : 'Approve setup'}</button>
  </section>;
}
