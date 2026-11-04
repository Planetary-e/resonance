import { useEffect, useState } from 'react';
import { cancelRelayHistoryOperation, getRelayPolicyObserverRecoveryInput, runRelayPolicyObserverRecovery,
  type RelayPolicyObserverRecoveryInput, type RelayPolicyObserverRecoveryAction, type RelayPolicyObserverRecoveryResult } from '../api.client';
const empty: RelayPolicyObserverRecoveryInput = { configurationFile: '', workspaceDirectory: '', restoredDirectory: '', outputFile: '',
  operatorTransportFile: '', source: 'available', view: 1 };
const fields = [['configurationFile', 'Original observer configuration file'], ['workspaceDirectory', 'Recovery workspace folder'],
  ['restoredDirectory', 'Separate restored history folder'], ['outputFile', 'New restored configuration file (needed for export)'],
  ['operatorTransportFile', 'Pinned maintenance routing file (optional)']] as const;
export default function PolicyObserverRecovery({ blocked = false, onBusyChange }: { blocked?: boolean; onBusyChange: (busy: boolean) => void }) {
  const [input, setInput] = useState(empty), [result, setResult] = useState<RelayPolicyObserverRecoveryResult | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => { let live = true;
    void getRelayPolicyObserverRecoveryInput().then(value => { if (live) {
      if (value.error) setError(value.error); else if (value.input) setInput(value.input); setLoading(false);
    } }); return () => { live = false; };
  }, []);
  const disabled = blocked || busy || loading;
  function change(next: RelayPolicyObserverRecoveryInput) { setInput(next); setResult(null); setError(''); }
  async function run(action: RelayPolicyObserverRecoveryAction) {
    const applying = ['start', 'restore', 'resume', 'export'].includes(action), approval = applying ? result?.approvalDigest : undefined;
    if (applying && !approval) return;
    setBusy(true); onBusyChange(true); setError(''); setResult(null);
    try {
      const value = await runRelayPolicyObserverRecovery(action, input, approval);
      if (value.error) setError(value.error); else setResult(value.result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Observer recovery failed; retain all files'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <section className="relay-section" aria-label="Recover policy observer history">
    <h4>Recover policy observer history</h4>
    <p className="text-sm">Keep the old observer stopped. Use its retained keys and original configuration. Start in a new workspace, or resume the same workspace after an interruption.</p>
    <form onSubmit={event => { event.preventDefault(); void run('plan'); }}>
      {fields.map(([field, label]) => <label key={field} className="form-group" style={{ display: 'block' }}>{label}
        <input type="text" required={field !== 'operatorTransportFile' && field !== 'outputFile'} disabled={disabled} autoComplete="off" spellCheck={false}
          value={input[field]} onChange={event => change({ ...input, [field]: event.target.value })} />
      </label>)}
      <label className="form-group" style={{ display: 'block' }}>Original local history
        <select value={input.source} disabled={disabled} onChange={event => change({ ...input, source: event.target.value as 'available' | 'unavailable' })}>
          <option value="available">Available: include all retained local evidence</option>
          <option value="unavailable">Unavailable: explicitly recover from volunteer copies</option>
        </select>
      </label>
      <p className="text-sm">An unreadable or busy source is not automatically treated as lost. If it is unavailable, volunteers cannot prove that unsaved local evidence never existed.</p>
      <label className="form-group" style={{ display: 'block' }}>Agreement view
        <input type="number" min={1} max={1000000} step={1} value={input.view} disabled={disabled} onChange={event => change({ ...input, view: Number(event.target.value) })} />
      </label>
      <p className="text-sm">Start with view 1. Timeouts do not raise it automatically. Preserve the existing workspace before reviewing a different view.</p>
      <button type="submit" className="btn btn-secondary" disabled={disabled}>Review observer recovery</button>
      <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => void run('status')}>Resume observer workspace</button>
    </form>
    {result && <PolicyObserverRecoveryProgress result={result} busy={disabled} onAction={action => void run(action)} />}
    {busy && <p role="status">Running one bounded recovery operation… <button type="button" className="btn btn-secondary" onClick={() => { void cancelRelayHistoryOperation(); }}>Cancel operation</button></p>}
    {error && <div role="alert"><p>{error}</p><p className="text-sm">Keep every history and workspace file. Cancellation cannot undo an accepted freeze. Resume this workspace to inspect retained progress.</p></div>}
  </section>;
}
export function PolicyObserverRecoveryProgress({ result, busy, onAction }: { result: RelayPolicyObserverRecoveryResult; busy: boolean;
  onAction: (action: RelayPolicyObserverRecoveryAction) => void }) {
  const button = (action: RelayPolicyObserverRecoveryAction, label: string) => <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onAction(action)}>{label}</button>;
  const phase = { freeze: 'Freeze the previous generation', select: 'Select agreed history', 'download-and-confirm': 'Verify complete policy history',
    provision: 'Prepare successor copies', review: 'Ready for restoration review' };
  return <section aria-label="Observer recovery progress">
    {result.kind === 'policy-observer-recovery-freeze' ? <>
      <h4>Review observer recovery freeze</h4>
      <p>Generation {result.generation} → {result.nextGeneration}, view {result.view}.</p>
      <p>{result.localStateDigest ? 'The available source contributes its authenticated local evidence and is permanently retired before recovery proceeds.'
        : 'You declared the local source unavailable. Recovery uses the independently pinned volunteer history.'}</p>
      <p>Approval starts an irreversible freeze. Existing signatures and conflicting policies remain retained. Every later phase is a separate step.</p>
      {button('start', 'Approve freeze and prepare observer recovery')}
    </> : result.kind === 'policy-observer-restore' ? <>
      <h4>Review restored observer history</h4>
      <p>Policy revision {result.policyRevision} · generation {result.generation} · {result.blocks} verified history blocks.</p>
      <p style={{ overflowWrap: 'anywhere' }}>{result.directory}</p>
      {result.blocked && <p role="alert">Conflicting signed policies will remain preserved. Restoration does not make this observer able to certify a policy.</p>}
      <p>Approval writes the reviewed state to the separate folder. The relay remains paused.</p>
      {button('restore', 'Approve observer restoration')}
    </> : result.kind === 'policy-restoration-resumption' ? <>
      <h4>Review retained observer restoration</h4>
      <p>Policy revision {result.policyRevision} · generation {result.generation}.</p>
      <p>Only authenticated pristine components may be completed. Missing accepted history cannot be recreated. Completion checks four current copies.</p>
      {button('resume', 'Approve restoration completion')}
    </> : result.kind === 'policy-observer-configuration-export' ? <>
      <h4>Review restored configuration export</h4><p style={{ overflowWrap: 'anywhere' }}>{result.output}</p>
      <p>The restored history has been checked against this workspace. Export does not start the relay or replace its selected observer.</p>
      {button('export', 'Approve restored configuration export')}
    </> : result.result === 'policy-restoration-configuration-exported' ? <>
      <h4>Restored configuration exported</h4><p style={{ overflowWrap: 'anywhere' }}>{result.output}</p>
      <p>The relay stays paused. Replacing a selected observer generation requires a separate activation review.</p>
    </> : result.result === 'policy-history-restored' || result.result === 'policy-restoration-resumed' ? <>
      <h4>Observer restoration retained</h4><p>The relay stays paused.</p>
      {button('resume-plan', 'Review retained restoration')}{button('export-plan', 'Review restored configuration export')}
    </> : result.complete && result.destinationOccupied ? <>
      <h4>Restoration folder contains files</h4><p>Keep those files. Check them against this completed workspace before continuing.</p>
      {button('resume-plan', 'Review retained restoration')}{button('export-plan', 'Review restored configuration export')}
    </> : result.phase ? <>
      <h4>{phase[result.phase]}</h4><p>Generation {result.generation} → {result.nextGeneration}, view {result.view}.</p>
      <p>Progress is retained across locking or closing the app.</p>
      {button(result.complete ? 'review' : 'step', result.complete ? 'Review observer restoration' : 'Run next observer recovery step')}
    </> : <p>Inspect the saved workspace before continuing.</p>}
  </section>;
}
