/** Final desktop storage handoff. Approval publishes a pinned selection, native
 * definitions and disabled settings under one stopped owner. It never starts a
 * service or removes maintenance; partial publication is retained for retry. */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { openRelayStorageOwner, type RelayStorageOwner } from '@resonance/relay';
import { relayPortClosed } from '../../../relay/src/relay-listener.js';
import { readDesktopStorageBootstrapIntent } from './relay-storage-bootstrap.js';
import { desktopRelayStorageControls } from './relay-storage.js';
import { reviewDesktopStoragePublication } from './relay-storage-publication.js';
import { stopRelayServiceForStorageActivation } from './relay-service-stop.js';
import { prepareRelayServiceInstallation, relayServiceOutputPaths, validateRelayServicePaths,
  RELAY_SERVICE_FILE_MAX_BYTES, type RelayServiceOptions } from './relay-supervisor.js';
import type { RelayConfig } from './session.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function openDesktopStorageActivationReview(options: {
  dataDirectory: string; config: RelayConfig; service: RelayServiceOptions;
  saveConfig(config: RelayConfig): void; signal?: AbortSignal; approvalTimeoutMs?: number;
}) {
  const config = structuredClone(options.config), service = structuredClone(options.service), signal = options.signal, saveConfig = options.saveConfig;
  const timeout = options.approvalTimeoutMs ?? 60000;
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000 || config.runtime?.storageSelectionFile
    || service.storageSelectionFile || typeof saveConfig !== 'function' || service.port !== config.port || resolve(service.dataDir) !== resolve(options.dataDirectory)) {
    throw new Error('Select an unconfigured stopped desktop relay for storage activation');
  }
  // Validate all currently available role files and bounded native rendering.
  // The selected document is absent until apply; actual preparation below always
  // validates that published file again, without a preview bypass.
  validateRelayServicePaths(service);
  const pins = readDesktopStorageBootstrapIntent(options.dataDirectory, config.port);
  const selected = { authorityDirectory: pins.authorityDirectory, authorityId: pins.intent.authorityId,
    runtimeDirectory: pins.runtimeDirectory, runtimePort: config.port, runtimeHost: '127.0.0.1' as const, dataDirectory: pins.dataDirectory };
  const releaseControl = acquireLocalStateLock(join(pins.dataDirectory, 'relay-desktop-control'));
  let owner: RelayStorageOwner | undefined, closed = false, cleanupFailed = false, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = performance.now() + timeout;
  function close() {
    if (closed) return; closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abandon);
    try { try { owner?.close(); } finally { releaseControl(); } }
    catch (error) { cleanupFailed = true; throw error; }
  }
  function abandon() { try { close(); } catch { /* Keep uncertain ownership; the next call reports it. */ } }
  function check() {
    if (closed) throw new Error(cleanupFailed ? 'Storage activation cleanup failed; inspect retained ownership' : 'Storage activation review is closed; review again');
    if (signal?.aborted || performance.now() >= deadline) { close(); throw new Error('Storage activation review expired or cancelled'); }
    if (JSON.stringify(readDesktopStorageBootstrapIntent(pins.dataDirectory, config.port)) !== JSON.stringify(pins)) throw new Error('Storage bootstrap pins changed during activation');
    owner?.status();
  }
  try {
    owner = openRelayStorageOwner(selected, 'maintenance', desktopRelayStorageControls(pins.dataDirectory));
    const held = owner;
    signal?.addEventListener('abort', abandon, { once: true }); timer = setTimeout(abandon, timeout); timer.unref();
    if (!await relayPortClosed(config.port)) throw new Error('Configured relay listener is not closed; stop it before storage activation');
    check();
    const inspect = () => {
      check(); validateRelayServicePaths(service);
      const publication = reviewDesktopStoragePublication(held, selected).review();
      const outputs = relayServiceOutputPaths(pins.dataDirectory);
      const budget = held.reviewWriteBudget([publication.request, ...desktopRelayStorageControls(pins.dataDirectory),
        ...outputs.map(path => ({ path, scope: 'file' as const, component: 'operator-atomic-output', maximumBytes: 9 * RELAY_SERVICE_FILE_MAX_BYTES + 8192 }))]);
      return { kind: 'desktop-storage-activation-review' as const, authorityId: selected.authorityId,
        selectionFile: publication.output, reusesPublishedOutput: publication.reusesPublishedOutput,
        nativeOutputFiles: outputs, budget, fits: budget.fits, maintenanceActive: true as const,
        startsService: false as const, publicationDigest: publication.approvalDigest };
    };
    const details = inspect(), approvalDigest = digest(['resonance:desktop-storage-activation:v1', details, pins.source, config, service]);
    return {
      review() { check(); return structuredClone({ ...details, approvalDigest }); },
      apply(approved: string) {
        try {
          check();
          if (approved !== approvalDigest || digest(['resonance:desktop-storage-activation:v1', inspect(), pins.source, config, service]) !== approved) throw new Error('Storage activation approval changed; review again');
          if (!details.fits) throw new Error('Storage activation outputs exceed the available budget; review a sufficient limit');
          // Native commands cannot run inside the managed writer context. The
          // desktop/runtime claims and persistent pause remain held throughout.
          stopRelayServiceForStorageActivation(); check();
          const publication = reviewDesktopStoragePublication(held, selected);
          const published = publication.apply(details.publicationDigest); check();
          const { dataDir: _dataDir, port: _port, contacts, controls, adminKey, ...runtime } = service;
          const next: RelayConfig = { ...config, enabled: false, contacts, controls, adminKey,
            runtime: { ...runtime, storageSelectionFile: published.output } };
          held.run(() => {
            // Intentionally discard the start capability; resuming is a separate
            // existing desktop action after the successful, visible handoff.
            prepareRelayServiceInstallation({ ...service, storageSelectionFile: published.output });
            check(); saveConfig(next);
          });
          check();
          return { result: 'desktop-storage-activated' as const, selectionFile: published.output, ...held.status(),
            maintenanceActive: true as const, running: false as const };
        } finally { close(); }
      }, close,
    };
  } catch (error) { close(); throw error; }
}
