import { useState } from 'react';
import { measureRelayStorage, cancelRelayHistoryOperation, type RelayStorageInventory } from '../api.client';
export default function HistoryStorage({ onBusyChange, blocked = false }: { onBusyChange: (busy: boolean) => void; blocked?: boolean }) {
  const [result, setResult] = useState<RelayStorageInventory | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function measure() {
    setBusy(true); onBusyChange(true); setError(''); setResult(null);
    try { const value = await measureRelayStorage(); if (value.error) setError(value.error); else setResult(value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Storage inventory unavailable'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <section className="relay-section" aria-label="History storage inventory">
    <h4>Stored relay and history files</h4>
    <p className="text-sm">Measure the relay folder and known owner, volunteer and recovery locations while paused. Locations from earlier approved operations remain included, even if the operation did not finish. Files created elsewhere must be checked separately.</p>
    <button className="btn btn-secondary" type="button" disabled={busy || blocked} onClick={() => { void measure(); }}>Measure stored files</button>
    {busy && <button className="btn btn-secondary" type="button" onClick={() => { void cancelRelayHistoryOperation(); }}>Cancel measurement</button>}
    {result && <HistoryStorageResult result={result} />}
    {error && <p role="alert">{error} No total is available; existing files are preserved.</p>}
  </section>;
}
export function HistoryStorageResult({ result }: { result: RelayStorageInventory }) {
  return <div role="status">
    <p>{(result.logicalBytes / 1048576).toFixed(2)} MiB of file contents across {result.files} files and {result.scannedRoots} nonoverlapping roots.</p>
    <p>{result.allocatedBytes === null ? 'Filesystem allocation is unavailable.' : `Filesystem-reported allocation: ${(result.allocatedBytes / 1048576).toFixed(2)} MiB.`}</p>
    <p className="text-sm">Measured {new Date(result.completedAt).toLocaleString()}. This observation does not reserve space or enforce a combined quota. It excludes unselected locations and future writes. Filesystem sharing and other writers can change actual disk use.</p>
  </div>;
}
