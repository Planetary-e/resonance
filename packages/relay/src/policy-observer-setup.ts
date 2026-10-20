/** Reviewed initial preparation. Retain one exact encrypted root beside the
 * canonical owner key before exporting configuration; never regenerate it. */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { MAX_ADMISSION_POLICY_BYTES, assertAdmissionPolicyCurrent } from '@resonance/core/admission-policy';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, historyCheckpointEnvelopeByteLength, historyDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { parseAdmissionHistoryArchiveLimits } from './admission-history-config.js';
import { canonicalHistorySetupPath, historySetupContains } from './admission-history-setup.js';
import { readOperatorFile, readOperatorSigningKey, readOperatorStorageKey, writeOperatorJsonNew } from './admission-operator-files.js';
import { parseAdmissionPolicyObserverState } from './admission-policy-observer-state.js';
import { assertPolicyObserverHistoryContext, decodePolicyObserverSnapshot, policyObserverHistoryContext } from './policy-observer-history-replay.js';
import { createPolicyObserverHistoryRoot } from './protected-policy-observer.js';
import { POLICY_OBSERVER_CONFIGURATION_MAX_BYTES, parsePolicyObserverConfiguration, parsePolicyObserverListener,
  parsePolicyObserverMemberPins, parsePolicyObserverPath } from './policy-observer-config.js';

const SETUP_MAX_BYTES = 64 * 1024;
export const POLICY_OBSERVER_ROOT_SUFFIX = '.policy-observer-root.json';
export const POLICY_OBSERVER_ENROLLMENT_MAX_BYTES = HISTORY_ENVELOPE_MAX_BYTES + 64 * 1024;
function json(path: string, maximum: number): unknown {
  const bytes = readOperatorFile(path, maximum);
  try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Policy observer setup input must be valid UTF-8 JSON'); }
  finally { bytes.fill(0); }
}
function absent(path: string) {
  try { lstatSync(path); throw new Error('Policy setup output already exists; retain it and choose another output'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!lstatSync(dirname(path)).isDirectory()) throw new Error('Policy setup output needs an existing parent');
}
function empty(path: string) {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || readdirSync(path).length)) throw new Error('New policy setup needs an empty owner directory; retain existing history');
}
export async function openPolicyObserverSetup(input: { setupFile: string; output: string; mode: 'new' | 'export' }, signal?: AbortSignal) {
  const run = captureStorageReservationOperation(); signal?.throwIfAborted();
  if (!['new', 'export'].includes(input.mode)) throw new Error('Invalid policy observer setup mode');
  const value = json(input.setupFile, SETUP_MAX_BYTES), base = dirname(resolve(input.setupFile));
  if (!exactWitnessFields(value, ['version', 'kind', 'context', 'members', 'directory', 'signingKeyFile', 'storageKeyFile', 'policyFile', 'limits', 'listen'])
    || value.version !== 1 || value.kind !== 'policy-observer-setup') throw new Error('Invalid policy observer setup configuration');
  const context = parseAdmissionPolicyObservers(value.context), limits = parseAdmissionHistoryArchiveLimits(value.limits);
  const path = (raw: unknown) => canonicalHistorySetupPath(parsePolicyObserverPath(raw, base));
  const selectedDirectory = value.directory, selectedSigningKey = value.signingKeyFile, selectedStorageKey = value.storageKeyFile, selectedPolicy = value.policyFile;
  const directory = path(selectedDirectory), signingKeyFile = path(value.signingKeyFile), storageKeyFile = path(value.storageKeyFile), policyFile = path(value.policyFile);
  const anchor = signingKeyFile + POLICY_OBSERVER_ROOT_SUFFIX, output = canonicalHistorySetupPath(input.output);
  const sources: Array<[string, number]> = [[resolve(input.setupFile), SETUP_MAX_BYTES], [signingKeyFile, 4096], [storageKeyFile, 128], [policyFile, MAX_ADMISSION_POLICY_BYTES]];
  if ([anchor, output, ...sources.map(([p]) => canonicalHistorySetupPath(p))].some(p => historySetupContains(directory, p))) {
    throw new Error('Keep policy setup keys, preparation anchor and configuration outside owner history');
  }
  const capture = () => sources.map(([p, maximum]) => {
    const bytes = readOperatorFile(p, maximum);
    try { return [canonicalHistorySetupPath(p), historyDigest(bytes)]; } finally { bytes.fill(0); }
  });
  const captured = capture(); absent(output);
  if (input.mode === 'new') { absent(anchor); empty(directory); }
  const signer = readOperatorSigningKey(signingKeyFile);
  let key: Buffer | undefined, closed = false, busy = false, applied = false;
  function close() { if (!closed) { closed = true; key?.fill(0); signer.secretKey.fill(0); } }
  function live() { if (closed) throw new Error('Policy setup closed'); signal?.throwIfAborted(); }
  try {
    key = readOperatorStorageKey(storageKeyFile);
    const historyContext = policyObserverHistoryContext(context, Buffer.from(signer.publicKey).toString('base64url'));
    const members = parsePolicyObserverMemberPins(value.members, historyContext.members), listen = parsePolicyObserverListener(value.listen);
    const initial = await parseAdmissionPolicyObserverState({ version: 1, contextId: admissionPolicyObserversId(context),
      policy: json(policyFile, MAX_ADMISSION_POLICY_BYTES), previous: null, advance: null, conflict: null }, context); live();
    if (historyCheckpointEnvelopeByteLength({ context: historyContext, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
      plaintextBytes: Buffer.byteLength(JSON.stringify(initial)) }) > limits.archiveBytes) throw new Error('Policy archive budget cannot retain its initial root');
    const configuration = (root: unknown) => parsePolicyObserverConfiguration({ version: 1, kind: 'policy-observer-configuration',
      context, historyContext, genesis: root, root, members, directory, signingKeyFile, storageKeyFile, limits, listen }, '/');
    let retained: ReturnType<typeof configuration> | undefined, anchorDigest: string | null = null;
    if (input.mode === 'export') {
      retained = parsePolicyObserverConfiguration(json(anchor, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES), '/');
      if (JSON.stringify(retained) !== JSON.stringify(configuration(retained.genesis))) throw new Error('Policy preparation differs from selected setup inputs');
      const state = await decodePolicyObserverSnapshot(retained.genesis, historyContext, context, key); live();
      if (JSON.stringify(state) !== JSON.stringify(initial)) throw new Error('Policy preparation contains a different initial state');
      const bytes = readOperatorFile(anchor, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES);
      try { anchorDigest = historyDigest(bytes); } finally { bytes.fill(0); }
    } else { if (initial.policy.version === 3) throw new Error('Fresh observer setup refuses v3 genesis'); assertAdmissionPolicyCurrent(initial.policy, Date.now()); }
    const details = { kind: 'policy-observer-preparation' as const, mode: input.mode, output, directory, anchor,
      contextId: historyCheckpointContextId(historyContext), owner: historyContext.owner, members, limits, listen,
      genesisId: retained ? historyCheckpointEnvelopeId(retained.genesis) : null, anchorDigest,
      policyRevision: initial.policy.revision, readiness: 'unverified' as const, startsService: false as const };
    const review = { ...details, approvalDigest: historyDigest(`resonance:policy-observer-preparation:v1\n${JSON.stringify([details, captured])}`) };
    function check() {
      live(); absent(output);
      if (canonicalHistorySetupPath(input.output) !== output || canonicalHistorySetupPath(parsePolicyObserverPath(selectedDirectory, base)) !== directory
        || JSON.stringify(capture()) !== JSON.stringify(captured) || JSON.stringify(json(input.setupFile, SETUP_MAX_BYTES)) !== JSON.stringify(value)
        || path(selectedSigningKey) !== signingKeyFile || path(selectedStorageKey) !== storageKeyFile || path(selectedPolicy) !== policyFile) {
        throw new Error('Policy setup selection changed; review again');
      }
      if (input.mode === 'new') { absent(anchor); empty(directory); if (initial.policy.version === 3) throw new Error('Fresh observer setup refuses v3 genesis'); assertAdmissionPolicyCurrent(initial.policy, Date.now()); }
      else {
        const bytes = readOperatorFile(anchor, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES);
        try { if (historyDigest(bytes) !== anchorDigest) throw new Error('Policy preparation changed; retain it and inspect'); } finally { bytes.fill(0); }
      }
    }
    check();
    return { review() { live(); return structuredClone(review); },
      locations() { live(); return { directories: [directory], files: [anchor, output], inputs: sources.map(([p]) => canonicalHistorySetupPath(p)) }; },
      async apply(approved: string) { return run(async () => {
      live(); if (busy || applied || approved !== review.approvalDigest) throw new Error('Policy setup requires matching reviewed approval');
      check(); busy = true;
      try {
        if (!retained) {
          const prepared = await createPolicyObserverHistoryRoot({ context, signingKey: signer, encryptionKey: key!, policy: initial.policy });
          check(); retained = configuration(prepared.root);
          if (Buffer.byteLength(JSON.stringify(prepared.root)) > limits.archiveBytes) throw new Error('Policy archive budget cannot retain its initial root');
          // Exclusive publication is the one-time anchor. A partial output is
          // retained and refused; a complete output can only be re-exported.
          writeOperatorJsonNew(anchor, retained, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES);
        }
        live(); writeOperatorJsonNew(output, retained, POLICY_OBSERVER_CONFIGURATION_MAX_BYTES); applied = true;
        return { result: 'policy-observer-prepared' as const, output, anchor, genesisId: historyCheckpointEnvelopeId(retained.genesis),
          readiness: 'unverified' as const, startsService: false as const };
      } catch (error) { close(); throw error; } finally { busy = false; }
    }); }, close };
  } catch (error) { close(); throw error; }
}

/** Public enrollment contains no local paths or private/storage keys. */
export function policyObserverEnrollment(configuration: ReturnType<typeof parsePolicyObserverConfiguration>) {
  const config = parsePolicyObserverConfiguration(configuration, '/');
  return { version: 1, kind: 'policy-observer-enrollment', context: config.context, historyContext: config.historyContext, root: config.genesis };
}
export function readPolicyObserverEnrollment(path: string) {
  const value = json(path, POLICY_OBSERVER_ENROLLMENT_MAX_BYTES);
  if (!exactWitnessFields(value, ['version', 'kind', 'context', 'historyContext', 'root']) || value.version !== 1 || value.kind !== 'policy-observer-enrollment') {
    throw new Error('Invalid policy observer enrollment');
  }
  const context = parseAdmissionPolicyObservers(value.context), historyContext = parseHistoryCheckpointContext(value.historyContext);
  assertPolicyObserverHistoryContext(context, historyContext);
  const root = parseHistoryCheckpointEnvelope(value.root, historyContext);
  if (root.kind !== 'checkpoint' || root.generation !== 0 || root.sequence !== 0) throw new Error('Policy volunteer enrollment needs original genesis');
  return { context, historyContext, root, contextId: historyCheckpointContextId(historyContext), genesisId: historyCheckpointEnvelopeId(root) };
}
