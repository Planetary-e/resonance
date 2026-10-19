/** Explicit selection of an already funded, complete recovery download. No network or initialization. */
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { assertExistingStorageReservation } from '@resonance/core/storage-reservations';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { parseHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { canonicalHistorySetupPath } from './admission-history-setup.js';
import { readOperatorFile } from './admission-operator-files.js';
import { createHistoryAncestryDownload, HISTORY_DOWNLOAD_FILENAME } from './history-ancestry-download.js';
import type { HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';

export interface HistoryAncestrySelection {
  version: 1; kind: 'recovery-download'; directory: string; enrollmentFile: string; continuationFile: string;
  funding: { authorityDirectory: string; authorityId: string };
}
export interface OwnedHistoryAncestrySource { readonly binding?: string; blocks(): Iterable<HistoryCheckpointEnvelope>; close(): void }
export function parseHistoryAncestrySelection(value: unknown): HistoryAncestrySelection {
  const path = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
  if (!exactWitnessFields(value, ['version', 'kind', 'directory', 'enrollmentFile', 'continuationFile', 'funding']) || value.version !== 1 || value.kind !== 'recovery-download'
    || !path(value.directory) || !path(value.enrollmentFile) || !path(value.continuationFile)
    || !exactWitnessFields(value.funding, ['authorityDirectory', 'authorityId']) || !path(value.funding.authorityDirectory)
    || typeof value.funding.authorityId !== 'string' || !/^[a-f0-9]{32}$/.test(value.funding.authorityId)) throw new Error('Invalid explicit recovery ancestry selection');
  return structuredClone(value) as unknown as HistoryAncestrySelection;
}
/** Read-only preflight of the downloader's original peaks, independent of child writer limits. */
export function assertExistingHistoryAncestryFunding(directory: string, authorityId?: string, options: { allowUnmanaged?: boolean } = {}) {
  const selectedId = assertExistingStorageReservation({ path: directory, component: 'history-download-ciphertext', scope: 'directory', maximumBytes: 252 * 1024 * 1024 }, authorityId, options);
  assertExistingStorageReservation({ path: join(directory, HISTORY_DOWNLOAD_FILENAME), component: 'encrypted-local-state', scope: 'file', maximumBytes: 4 * 1024 * 1024 + 8192 }, authorityId, options);
  return selectedId;
}
/** Capture original paths, canonical identities and independent pin bytes before any caller await. */
export function captureHistoryAncestrySource(value: HistoryAncestrySelection, configurationFile: string, suppliedContext: HistoryCheckpointContext) {
  const selection = parseHistoryAncestrySelection(value), context = parseHistoryCheckpointContext(structuredClone(suppliedContext));
  const base = dirname(resolve(configurationFile));
  const originals = { directory: resolve(base, selection.directory), enrollmentFile: resolve(base, selection.enrollmentFile),
    continuationFile: resolve(base, selection.continuationFile), authorityDirectory: resolve(base, selection.funding.authorityDirectory) };
  const paths = Object.fromEntries(Object.entries(originals).map(([name, path]) => [name, canonicalHistorySetupPath(path)])) as typeof originals;
  const identities = Object.fromEntries(Object.entries(paths).map(([name, path]) => { const stat = lstatSync(path); return [name, [stat.dev, stat.ino]]; }));
  const bytes = (path: string) => readOperatorFile(path, HISTORY_ENVELOPE_MAX_BYTES + 65536);
  const enrollmentBytes = bytes(paths.enrollmentFile), continuationBytes = bytes(paths.continuationFile);
  const enrollmentDigest = historyDigest(enrollmentBytes), continuationDigest = historyDigest(continuationBytes);
  let enrollment: unknown, continuation: unknown;
  try { enrollment = JSON.parse(enrollmentBytes.toString('utf8')); continuation = JSON.parse(continuationBytes.toString('utf8')); }
  finally { enrollmentBytes.fill(0); continuationBytes.fill(0); }
  if (!exactWitnessFields(enrollment, ['version', 'kind', 'context', 'root']) || enrollment.version !== 1 || enrollment.kind !== 'admission-history-enrollment'
    || historyCheckpointContextId(parseHistoryCheckpointContext(enrollment.context)) !== historyCheckpointContextId(context)) throw new Error('Ancestry requires independently pinned matching original enrollment');
  const genesis = parseHistoryCheckpointEnvelope(enrollment.root, context), root = parseHistoryContinuationRoot(continuation, context);
  if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Ancestry requires original genesis enrollment');
  const manifestPath = join(paths.directory, HISTORY_DOWNLOAD_FILENAME), manifestBytes = readOperatorFile(manifestPath, 2 * 1024 * 1024 + 8192);
  const manifestDigest = historyDigest(manifestBytes); manifestBytes.fill(0);
  const expectedAncestry = Object.freeze({ genesisId: historyCheckpointEnvelopeId(genesis), rootId: historyCheckpointEnvelopeId(root) });
  const binding = { selection, paths, identities, enrollmentDigest, continuationDigest, manifestDigest, ...expectedAncestry };
  function check() {
    for (const [name, original] of Object.entries(originals)) {
      const current = canonicalHistorySetupPath(original), stat = lstatSync(current);
      if (current !== paths[name as keyof typeof paths] || JSON.stringify([stat.dev, stat.ino]) !== JSON.stringify(identities[name])) throw new Error('Selected ancestry path identity changed');
    }
    const manifest = readOperatorFile(manifestPath, 2 * 1024 * 1024 + 8192); try { if (historyDigest(manifest) !== manifestDigest) throw new Error('Selected ancestry manifest changed'); } finally { manifest.fill(0); }
    for (const [path, digest] of [[paths.enrollmentFile, enrollmentDigest], [paths.continuationFile, continuationDigest]]) {
      const current = bytes(path); try { if (historyDigest(current) !== digest) throw new Error('Selected ancestry pin file changed'); } finally { current.fill(0); }
    }
  }
  return Object.freeze({
    funding: { authorityDirectory: paths.authorityDirectory, authorityId: selection.funding.authorityId },
    expectedAncestry, binding: historyDigest(JSON.stringify(binding)), check,
    /** A prior-owner source may start another recovery, but cannot select its child restore. */
    assertRecoveryDownload(pins: { directory: string; genesisId: string; continuation?: unknown }) {
      check();
      if (canonicalHistorySetupPath(pins.directory) !== paths.directory || pins.genesisId !== expectedAncestry.genesisId) throw new Error('Selected ancestry does not match the actual recovery download or original genesis');
      if (pins.continuation !== undefined && historyCheckpointEnvelopeId(parseHistoryContinuationRoot(pins.continuation, context)) !== expectedAncestry.rootId) throw new Error('Selected ancestry continuation differs from the completed recovery');
      assertExistingHistoryAncestryFunding(paths.directory, selection.funding.authorityId);
    },
    open(options: { localKey: Uint8Array; signingKey: SigningKeyPair; members: HistoryReplicaEndpoint[] }): OwnedHistoryAncestrySource {
      check();
      assertExistingHistoryAncestryFunding(paths.directory, selection.funding.authorityId);
      const download = createHistoryAncestryDownload({ directory: paths.directory, context, localKey: options.localKey, signingKey: options.signingKey,
        members: options.members, proposal: root.proposal, initialize: false, maxBytes: 256 * 1024 * 1024, maxBlocks: 10001 });
      try {
        if (!download.read().complete) throw new Error('Selected ancestry download is incomplete');
        const first = download.blocks().next();
        if (first.done || historyCheckpointEnvelopeId(first.value) !== expectedAncestry.genesisId) throw new Error('Selected ancestry does not contain its original genesis');
        check();
        return Object.freeze({ binding: historyDigest(JSON.stringify(binding)), blocks() { check(); return download.blocks(); }, close() { download.close(); } });
      } catch (error) { download.close(); throw error; }
    },
  });
}
