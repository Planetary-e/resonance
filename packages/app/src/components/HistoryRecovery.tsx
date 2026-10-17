import { useEffect, useState } from 'react';
import { getRelayHistoryRecoveryInput, runRelayHistoryRecovery, cancelRelayHistoryOperation,
  type RelayHistoryRecoveryInput, type RelayHistoryRecoveryAction, type RelayHistoryRecoveryResult } from '../api.client';

const empty: RelayHistoryRecoveryInput = { historyConfigFile: '', enrollmentFile: '', storageKeyFile: '', workspaceDirectory: '',
  policyFile: '', historyDirectory: '', operatorTransportFile: '', view: 1 };
const fields: Array<[Exclude<keyof RelayHistoryRecoveryInput, 'view'>, string]> = [
  ['historyConfigFile', 'Owner configuration file'], ['enrollmentFile', 'Independent enrollment backup'],
  ['storageKeyFile', 'History encryption key file'], ['workspaceDirectory', 'Recovery workspace folder'],
  ['policyFile', 'Current signed policy file'], ['historyDirectory', 'New restored history folder'],
  ['operatorTransportFile', 'Recovery connection file (optional)'],
];
export default function HistoryRecovery({ onBusyChange, blocked = false }: { onBusyChange: (busy: boolean) => void; blocked?: boolean }) {
  const [input, setInput] = useState<RelayHistoryRecoveryInput>(empty), [result, setResult] = useState<RelayHistoryRecoveryResult | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void getRelayHistoryRecoveryInput().then(response => {
      if (!current) return;
      if (response.error) setError(response.error); else if (response.input) setInput(response.input);
      setLoading(false);
    });
    return () => { current = false; };
  }, []);
  const disabled = busy || blocked || loading;
  function changed(next: RelayHistoryRecoveryInput) { setInput(next); setResult(null); setError(''); }
  async function run(action: RelayHistoryRecoveryAction) {
    const approval = action === 'start' || action === 'restore' ? result?.approvalDigest : undefined;
    if ((action === 'start' || action === 'restore') && !approval) return;
    setBusy(true); onBusyChange(true); setError(''); setResult(null);
    try {
      const response = await runRelayHistoryRecovery(action, input, approval);
      if (response.error) setError(response.error); else setResult(response);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Recovery failed; retain all files'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <section className="relay-section history-activation" aria-label="Recover owner history">
    <h4>Recover owner history</h4>
    <p className="text-sm">Use retained owner keys and the independent enrollment backup. Start with a new workspace, or select the same workspace to resume. Keep the old owner stopped.</p>
    <form onSubmit={event => { event.preventDefault(); void run('plan'); }}>
      {fields.map(([field, label]) => <label key={field} className="form-group" style={{ display: 'block' }}>
        {label}<input type="text" value={input[field]} required={field !== 'operatorTransportFile'} disabled={disabled} autoComplete="off" spellCheck={false}
          onChange={event => changed({ ...input, [field]: event.target.value })} style={{ width: '100%' }} />
      </label>)}
      <label className="form-group" style={{ display: 'block' }}>Agreement view
        <input type="number" min={1} max={1000000} step={1} value={input.view} disabled={disabled}
          onChange={event => changed({ ...input, view: Number(event.target.value) })} />
      </label>
      <p className="text-sm">Start with view 1. A timeout never raises it automatically. Preserve an existing workspace before reviewing a different view. Without a recovery connection file, requests use the pinned direct endpoints.</p>
      <div className="history-actions">
        <button className="btn btn-secondary" type="submit" disabled={disabled}>Review new recovery</button>
        <button className="btn btn-secondary" type="button" disabled={disabled} onClick={() => void run('status')}>Resume saved workspace</button>
      </div>
    </form>
    {result && <HistoryRecoveryProgress result={result} busy={disabled} onAction={action => void run(action)} />}
    {busy && <div role="status"><p>Running one bounded recovery operation…</p>
      <button className="btn btn-secondary" type="button" onClick={() => { void cancelRelayHistoryOperation().then(response => {
        if (response.error) setError(response.error);
      }); }}>Cancel operation</button>
      <p className="text-sm">Cancellation retains the workspace and cannot undo a freeze already accepted by volunteers.</p>
    </div>}
    {error && <div role="alert"><p>{error}</p><p className="text-sm">Maintenance and pending work remain. Resume the same workspace to inspect its status. If restoration published a history but readiness failed, retain that folder for readiness recovery; do not restore over it.</p></div>}
  </section>;
}

export function HistoryRecoveryProgress({ result, busy, onAction }: {
  result: RelayHistoryRecoveryResult; busy: boolean; onAction: (action: RelayHistoryRecoveryAction) => void;
}) {
  const phase = { freeze: 'Freeze the previous generation', select: 'Select agreed history', 'download-and-confirm': 'Download and confirm retained history',
    provision: 'Prepare the successor copies', review: 'Ready for restoration review' };
  return <section className="history-activation-review" aria-label="Recovery progress">
    {result.kind === 'admission-recovery-freeze' ? <>
      <h4>Review recovery freeze</h4>
      <p style={{ overflowWrap: 'anywhere' }}>Workspace: {result.directory}</p>
      <p>Generation {result.generation} → {result.nextGeneration}, view {result.view}</p>
      <p>This approval authorizes an irreversible freeze of the previous generation. Its ordinary writes and exact retries will stop. Accepted evidence is retained.</p>
      <p className="text-sm">Review contacted volunteers without freezing them. Approval creates the recovery journal; each following phase requires an explicit step.</p>
      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => onAction('start')}>Approve freeze and prepare recovery</button>
    </> : result.kind === 'admission-history-restore' ? <>
      <h4>Review restoration</h4>
      <p style={{ overflowWrap: 'anywhere' }}>New history folder: {result.directory}</p>
      <p>{result.spends} retained spends · {result.permanentDenials} permanent denials · generation {result.generation}</p>
      <p>Requested policy revision: {result.requestedPolicyRevision}</p>
      <p className="text-sm">Restore writes the reviewed history into the new folder and requires four fresh copies. It does not start the relay or replace witness/coordinator state.</p>
      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => onAction('restore')}>Approve restoration</button>
    </> : result.result === 'history-restored' ? <>
      <h4>Owner history restored</h4>
      <p>Generation {result.generation} passed its readiness check. The relay remains paused.</p>
      <p>Use Activate prepared owner history below with the restored folder, then leave maintenance and start explicitly. Startup checks current copies again.</p>
    </> : result.complete && result.destinationOccupied ? <>
      <h4>Restoration destination contains files</h4>
      <p>The recovery workspace is complete. Keep the destination folder; its presence alone does not confirm a completed restoration.</p>
      <p>Review Activate prepared owner history below to validate an already completed history. If readiness was interrupted, finish the explicit owner readiness workflow before activation.</p>
      <p className="text-sm">Do not restore over existing files or delete them to retry.</p>
    </> : result.phase ? <>
      <h4>{phase[result.phase]}</h4><p>Generation {result.generation} → {result.nextGeneration}, view {result.view}</p>
      <p className="text-sm">Progress is retained on disk. Closing or locking the app preserves it; a later session can resume this workspace.</p>
      <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => onAction(result.complete ? 'review' : 'step')}>
        {result.complete ? 'Review restoration' : 'Run next recovery step'}
      </button>
    </> : <p>Read the saved workspace status before continuing.</p>}
  </section>;
}
