/** Review/retry bounded immutable selection outputs. An invalid JSON prefix is
 * retained as an incomplete attempt; valid but conflicting pins require inspection.
 * Native startup and settings publication are separate operations. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';
import { readRelayStorageSnapshot, parseRelayStorageConfiguration, RELAY_STORAGE_SELECTION_MAX_BYTES,
  UnparseableRelayStorageSelectionError, assertStoppedRelayStorageOwner, type RelayStorageOwner, type RelayStorageSelection,
  type RelayStorageRuntimeBinding } from '@resonance/relay';
import { desktopRelayStorageControls, desktopStorageSelectionPaths } from './relay-storage.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const present = (path: string) => { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } };
export function reviewDesktopStoragePublication(owner: RelayStorageOwner, input: RelayStorageSelection & RelayStorageRuntimeBinding & { dataDirectory: string }) {
  const selected = { ...input }, paths = desktopStorageSelectionPaths(selected.dataDirectory);
  const configuration = parseRelayStorageConfiguration({ version: 1, kind: 'relay-storage-selection', authorityDirectory: selected.authorityDirectory,
    authorityId: selected.authorityId, runtimeDirectory: selected.runtimeDirectory, runtimePort: selected.runtimePort, runtimeHost: selected.runtimeHost,
    controls: desktopRelayStorageControls(selected.dataDirectory) });
  function inspect() {
    owner.run(() => assertStoppedRelayStorageOwner(selected));
    const attempts = paths.map(path => {
      const stat = present(path); if (!stat) return { path, state: 'absent' as const };
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > RELAY_STORAGE_SELECTION_MAX_BYTES) throw new Error('Storage selection attempts must be bounded ordinary files');
      try {
        const snapshot = readRelayStorageSnapshot(path);
        if (JSON.stringify(snapshot.configuration) !== JSON.stringify(configuration)) throw new Error('A retained storage selection has conflicting pins or controls; inspect it before activation');
        return { path, state: 'published' as const, source: snapshot.source };
      } catch (error) {
        if (!(error instanceof UnparseableRelayStorageSelectionError)) throw error;
        // The original writer allocated the whole output peak before opening.
        // Unparseable bytes are neither overwritten nor accepted as a selection.
        const after = lstatSync(path);
        const signature = (value: typeof stat) => [value.dev, value.ino, value.size, value.mode, value.mtimeMs, value.ctimeMs, value.nlink].join(':');
        if (signature(after) !== signature(stat)) throw new Error('Incomplete storage selection changed while inspecting');
        return { path, state: 'incomplete' as const, identity: signature(after) };
      }
    });
    const candidate = attempts.find(attempt => attempt.state === 'published') ?? attempts.find(attempt => attempt.state === 'absent');
    if (!candidate) throw new Error('Storage selection publication slots are full; retain them for inspection');
    const request = { path: candidate.path, scope: 'file' as const, component: 'operator-output', maximumBytes: RELAY_STORAGE_SELECTION_MAX_BYTES };
    const budget = owner.reviewWriteBudget([request]);
    const publication = candidate.state === 'absent' ? owner.reviewSelectionOutput(candidate.path, selected) : null;
    if (publication && JSON.stringify(publication.configuration) !== JSON.stringify(configuration)) throw new Error('Stopped owner controls differ from the desktop publication');
    return { kind: 'desktop-storage-publication-review' as const, output: candidate.path, reusesPublishedOutput: candidate.state === 'published',
      attempts, budget, publication, configuration, request };
  }
  const captured = inspect(), approvalDigest = digest(['resonance:desktop-storage-publication:v1', captured]); let attempted = false;
  return {
    review() { if (attempted) throw new Error('Storage publication already attempted; review again'); owner.status(); return structuredClone({ ...captured, approvalDigest }); },
    apply(approved: string) {
      if (attempted) throw new Error('Storage publication already attempted; review again'); attempted = true;
      if (approved !== approvalDigest || digest(['resonance:desktop-storage-publication:v1', inspect()]) !== approved) throw new Error('Storage publication approval changed; review again');
      if (!captured.budget.fits) throw new Error('Storage selection publication exceeds the available budget');
      if (captured.publication) owner.exportSelection(captured.output, selected, captured.publication.approvalDigest);
      else owner.run(() => {
        const lease = reserveManagedStorage(captured.request); lease?.assertWritable();
        const snapshot = readRelayStorageSnapshot(captured.output), previous = captured.attempts.find(attempt => attempt.path === captured.output)!;
        if (previous.state !== 'published' || JSON.stringify(snapshot.source) !== JSON.stringify(previous.source)) throw new Error('Published storage selection changed before confirmation');
        // A complete file may have survived an uncertain flush; confirm durability
        // again before allowing a separate settings handoff to reference it.
        const fd = openSync(captured.output, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
        try { fsyncSync(fd); } finally { closeSync(fd); }
        if (process.platform !== 'win32') { const parent = openSync(dirname(captured.output), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); } }
        if (JSON.stringify(readRelayStorageSnapshot(captured.output).source) !== JSON.stringify(snapshot.source)) throw new Error('Storage selection changed during confirmation');
      });
      return { result: 'desktop-storage-selection-published' as const, output: captured.output, snapshot: readRelayStorageSnapshot(captured.output) };
    },
  };
}
