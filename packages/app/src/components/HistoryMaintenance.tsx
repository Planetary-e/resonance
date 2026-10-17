import { useEffect, useState } from 'react';
import { getRelayMaintenance, beginRelayMaintenance, finishRelayMaintenance, type RelayMaintenanceStatus } from '../api.client';

export default function HistoryMaintenance({ refreshRelay }: { refreshRelay?: () => Promise<unknown> }) {
  const [state, setState] = useState<RelayMaintenanceStatus | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  async function refresh() {
    const result = await getRelayMaintenance();
    if (result.error) { setError(result.error); setState(null); } else setState(result);
  }
  useEffect(() => { void refresh(); }, []);
  async function change(begin: boolean) {
    setBusy(true); setError(''); setChecked(false);
    try {
      const result = await (begin ? beginRelayMaintenance() : finishRelayMaintenance());
      await refresh(); await refreshRelay?.();
      if (result.error) setError(result.error);
      else setChecked(begin);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to refresh relay maintenance');
    } finally { setBusy(false); }
  }
  return <HistoryMaintenanceView state={state} busy={busy} error={error} checked={checked} onChange={change} />;
}

export function HistoryMaintenanceView({ state, busy, error, checked, onChange }: {
  state: RelayMaintenanceStatus | null; busy: boolean; error: string; checked: boolean; onChange: (begin: boolean) => Promise<void>;
}) {
  return <section className="relay-section" aria-label="Protected history maintenance">
    <h4>Protected history maintenance</h4>
    {state?.active ? <>
      <p>Relay startup is paused for maintenance. Saved history and unfinished recovery work are retained.</p>
      <p className="text-sm">{checked ? 'The last check confirmed the managed relay was stopped.' : 'A saved pause does not confirm the running process has stopped. Check before continuing.'}</p>
      <p className="text-sm">Leaving maintenance allows a later relay start. It does not start the relay, complete recovery or erase pending work.</p>
      <button type="button" disabled={busy} onClick={() => void onChange(false)}>Leave maintenance</button>
      <button type="button" disabled={busy} onClick={() => void onChange(true)}>Check relay is stopped</button>
    </> : <>
      <p className="text-sm">Pause the background relay before preparing or recovering its protected history. This pause remains active if the app closes.</p>
      <button type="button" disabled={busy || !state} onClick={() => void onChange(true)}>Stop relay for maintenance</button>
    </>}
    {busy && <p role="status">Checking the background service…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
